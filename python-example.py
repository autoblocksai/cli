import os
import abc
import enum
import uuid
import time
import json
import httpx
import random
import hashlib
import inspect
import asyncio
import functools
import threading
import traceback
import contextvars
import dataclasses

from typing import Any
from typing import List
from typing import Optional
from typing import Callable
from typing import Coroutine


# Models
@dataclasses.dataclass(frozen=True)
class BaseTestCase(abc.ABC):
  @abc.abstractmethod
  def hash(self) -> str:
    pass

  @functools.cached_property
  def cached_hash(self) -> str:
    return self.hash()


@dataclasses.dataclass(frozen=True)
class Threshold:
  lt: Optional[float] = None
  lte: Optional[float] = None
  gt: Optional[float] = None
  gte: Optional[float] = None


@dataclasses.dataclass(frozen=True)
class Evaluation:
  score: float
  threshold: Optional[Threshold] = None


class BaseEvaluator(abc.ABC):
  @property
  @abc.abstractmethod
  def id(self) -> str:
      pass

  @abc.abstractmethod
  def evaluate(self, test_case: BaseTestCase, output: Any) -> Evaluation:
    pass


# Run utils
client = httpx.AsyncClient(base_url=os.environ['AUTOBLOCKS_CLI_SERVER_ADDRESS'])

current_test_id_var = contextvars.ContextVar('current_test_id')
current_test_case_var = contextvars.ContextVar('current_test_case')


loop = asyncio.new_event_loop()


def my_event_loop(_loop):
  asyncio.set_event_loop(_loop)
  _loop.run_forever()


background_thread = threading.Thread(
  target=my_event_loop,
  args=(loop,),
  daemon=True,
)
background_thread.start()


async def send_error(
  test_id: str,
  test_case_hash: str,
  evaluator_id: Optional[str],
  error: Exception,
) -> None:
  payload = dict(
    testExternalId=test_id,
    testCaseHash=test_case_hash,
    error=dict(
      name=type(error).__name__,
      message=str(error),
      stacktrace=traceback.format_exc(),
    ),
  )
  if evaluator_id:
    payload.update(evaluatorExternalId=evaluator_id)

  await client.post("/errors", json=payload)


async def gather_with_max_concurrency(max_concurrency: int, *coros: Coroutine) -> None:
    """
    Borrowed from https://stackoverflow.com/a/61478547
    """
    semaphore = asyncio.Semaphore(max_concurrency)

    async def sem_coro(coro: Coroutine):
        async with semaphore:
            return await coro

    # return_exceptions=True causes exceptions to be returned as values instead
    # of propagating them to the caller. this is similar in behavior to Promise.allSettled
    await asyncio.gather(*(sem_coro(c) for c in coros), return_exceptions=True)


async def evaluate_output(
  test_id: str,
  test_case: BaseTestCase,
  output: Any,
  evaluator: BaseEvaluator,
):
  evaluation = None

  if inspect.iscoroutinefunction(evaluator.evaluate):
    try:
      evaluation = await evaluator.evaluate(test_case, output)
    except Exception as err:
      await send_error(
        test_id=test_id,
        test_case_hash=test_case.cached_hash,
        evaluator_id=evaluator.id,
        error=err,
      )
  else:
    ctx = contextvars.copy_context()
    try:
      evaluation = await loop.run_in_executor(
        None,
        ctx.run,
        evaluator.evaluate,
        test_case,
        output,
      )
    except Exception as err:
      await send_error(
        test_id=test_id,
        test_case_hash=test_case.cached_hash,
        evaluator_id=evaluator.id,
        error=err,
      )

  if evaluation is None:
    return

  payload = dict(
    testExternalId=test_id,
    evaluatorExternalId=evaluator.id,
    testCaseHash=test_case.cached_hash,
    score=evaluation.score,
  )
  if evaluation.threshold:
    payload.update(
      threshold=dataclasses.asdict(evaluation.threshold),
    )
  await client.post("/evals", json=payload)


async def run_test_case(
  test_id: str,
  test_case: BaseTestCase,
  evaluators: List[BaseEvaluator],
  fn: Callable[[BaseTestCase], Any],
  max_evaluator_concurrency: int,
):
  current_test_id_var.set(test_id)
  current_test_case_var.set(test_case)

  output = None

  if inspect.iscoroutinefunction(fn):
    try:
      output = await fn(test_case)
    except Exception as err:
      await send_error(
        test_id=test_id,
        test_case_hash=test_case.cached_hash,
        evaluator_id=None,
        error=err,
      )
  else:
    ctx = contextvars.copy_context()
    try:
      output = await loop.run_in_executor(None, ctx.run, fn, test_case)
    except Exception as err:
      await send_error(
        test_id=test_id,
        test_case_hash=test_case.cached_hash,
        evaluator_id=None,
        error=err,
      )

  if output is None:
    return

  test_case_body = dataclasses.asdict(test_case)
  test_case_body.pop("batch_idx", None)

  await client.post("/results", json=dict(
    testExternalId=test_id,
    testCaseHash=test_case.cached_hash,
    testCaseBody=test_case_body,
    testCaseOutput=output,
  ))

  await gather_with_max_concurrency(max_evaluator_concurrency, *[
    evaluate_output(
      test_id=test_id,
      test_case=test_case,
      output=output,
      evaluator=evaluator,
    ) for evaluator in evaluators
  ])


async def run_test(
  test_id: str,
  test_cases: List[BaseTestCase],
  evaluators: List[BaseEvaluator],
  fn: Callable[[BaseTestCase], Any],
  max_test_case_concurrency: int,
  max_evaluator_concurrency: int,
):
  await client.post("/start", json=dict(testExternalId=test_id))

  await gather_with_max_concurrency(max_test_case_concurrency, *[
    run_test_case(
      test_id=test_id,
      test_case=test_case,
      evaluators=evaluators,
      fn=fn,
      max_evaluator_concurrency=max_evaluator_concurrency,
    ) for test_case in test_cases
  ])

  await client.post("/end", json=dict(testExternalId=test_id))


# Sync entrypoint
def test(
  id: str,
  test_cases: List[BaseTestCase],
  evaluators: List[BaseEvaluator],
  fn: Callable[[BaseTestCase], Any],
  # How many test cases to run concurrently
  max_test_case_concurrency: int = 10,
  # How many evaluators to run concurrently on the result of a test case
  max_evaluator_concurrency: int = 5,
):
  future = asyncio.run_coroutine_threadsafe(
    run_test(
      test_id=id,
      test_cases=test_cases,
      evaluators=evaluators,
      fn=fn,
      max_test_case_concurrency=max_test_case_concurrency,
      max_evaluator_concurrency=max_evaluator_concurrency,
    ),
    loop,
  )
  future.result()














# Example usage
with open("study_guide_outlines.json") as f:
  outlines = json.load(f)


@dataclasses.dataclass(frozen=True)
class TestCase(BaseTestCase):
  input: str
  expected_substrings: List[str]

  batch_idx: int

  def hash(self) -> str:
    return hashlib.md5(f"{self.input}{self.batch_idx}".encode()).hexdigest()
  

def gen_test_cases() -> List[TestCase]:
  test_cases = []
  for batch_idx in range(1):
    for outline in outlines[:2]:
      print("appending test case!!!")
      test_cases.append(
        TestCase(
          input=outline["topic"],
          expected_substrings=outline["topic"].split()[:2],
          batch_idx=batch_idx,
        ),
      )
  return test_cases


class HasSubstringsEvaluator(BaseEvaluator):
  id = "has-substrings"

  def evaluate(self, test_case: TestCase, output: str) -> Evaluation:
    # Real score
    score = 1 if all(sub in output for sub in test_case.expected_substrings) else 0

    return Evaluation(
      # Randomize for effect
      score=random.choices([0, 1], weights=[0.1, 0.9])[0],
      threshold=Threshold(
        gte=1,
      ),
    )


class NumberOfBulletsEvaluator(BaseEvaluator):
  id = "number-of-bullets"

  # These could also exist on each test case if it's not a global constraint
  min_bullets: int = 5
  max_bullets: int = 20

  def evaluate(self, test_case: TestCase, output: str) -> Evaluation:
    num_bullets = len(output.splitlines())
    # Real score
    score = 1 if self.min_bullets <= num_bullets <= self.max_bullets else 0

    # Or, if min_bullets and max_bullets are fields on each test case:
    # score = 1 if test_case.min_bullets <= num_bullets <= test_case.max_bullets else 0

    return Evaluation(
      # Randomize for effect
      score=random.choices([0, 1], weights=[0.1, 0.9])[0],
      threshold=Threshold(
        gte=1,
      ),
    )
  

class CoherenceEvaluator(BaseEvaluator):
  id = "coherence"

  # Async evaluators are supported
  async def evaluate(self, test_case: TestCase, output: str) -> Evaluation:
    # Simulate doing work
    await asyncio.sleep(random.random() * 3)

    return Evaluation(score=random.random())


class RelevanceEvaluator(BaseEvaluator):
  id = "relevance"

  # Synchronous evaluators are supported
  def evaluate(self, test_case: TestCase, output: str) -> Evaluation:
    # Simulate doing work
    time.sleep(random.random() * 3)

    if test_case.cached_hash == "c42a9da5475cf3e00b1824061d414eaa":
      raise Exception("oops")

    return Evaluation(
      score=random.random(),
      threshold=Threshold(
        gte=0.2,
      ),
    )


# This function can be sync or async
def generate_study_guide_outline(test_case: TestCase) -> str:
  # Simulate doing work
  time.sleep(random.random() * 3)
  
  # Get the mock outline from the json file
  outline = [o["outline"] for o in outlines if o["topic"] == test_case.input][0]

  # Remove some lines
  num_lines_to_remove = random.randint(1, 3)
  lines = outline.splitlines()
  idx_to_remove = random.sample(range(len(lines)), num_lines_to_remove)
  filtered_lines = [line for idx, line in enumerate(lines) if idx not in idx_to_remove]

  # Reorder some lines
  num_lines_to_reorder = random.randint(1, 3)
  idx_to_reorder = random.sample(range(len(filtered_lines)), num_lines_to_reorder)
  reordered_lines = filtered_lines.copy()
  for idx in idx_to_reorder:
    reordered_lines[idx] = filtered_lines[idx_to_reorder[-1]]
  
  return "\n".join(reordered_lines)


# async def generate_study_guide_outline(test_case: TestCase) -> str:
#   # Simulate doing work
#   await asyncio.time.sleep(random.random() * 3)
  
#   # Return the mock outline from the json file
#   return [o["outline"] for o in outlines if o["topic"] == test_case.topic][0]


test(
  id="study-guide-outlines",
  test_cases=gen_test_cases(),
  evaluators=[
    HasSubstringsEvaluator(),
    NumberOfBulletsEvaluator(),
    CoherenceEvaluator(),
    RelevanceEvaluator(),
  ],
  fn=generate_study_guide_outline,
  max_test_case_concurrency=20,
  max_evaluator_concurrency=2,
)
