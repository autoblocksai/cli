import os
import abc
import enum
import uuid
import time
import httpx
import hashlib
import inspect
import asyncio
import functools
import threading
import contextvars
import dataclasses

from typing import Any
from typing import List
from typing import Optional
from typing import Callable


# Models
class BaseTestCase(abc.ABC):
  @abc.abstractmethod
  def hash(self) -> str:
    pass


class ThresholdOp(enum.Enum):
  GT = '>'
  GTE = '>='
  LT = '<'
  LTE = '<='


@dataclasses.dataclass(frozen=True)
class Threshold:
  op: ThresholdOp
  value: float


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


@dataclasses.dataclass(frozen=True)
class TestCase(BaseTestCase):
  input: str
  expected_output: str

  @functools.cached_property
  def hash(self) -> str:
    return hashlib.md5(self.input.encode()).hexdigest()
  

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


async def evaluate_output(
  id: str,
  test_case: str,
  output: Any,
  evaluator: BaseEvaluator,
):
  if inspect.iscoroutinefunction(evaluator.evaluate):
    evaluation = await evaluator.evaluate(test_case, output)
  else:
    ctx = contextvars.copy_context()
    evaluation = await loop.run_in_executor(
      None,
      ctx.run,
      evaluator.evaluate,
      test_case,
      output,
    )

  await client.post("/evals", json=dict(
    testExternalId=id,
    testCaseHash=test_case.hash,
    evaluatorId=evaluator.id,
    score=evaluation.score,
    thresholdOp=evaluation.threshold.op.value if evaluation.threshold else None,
    thresholdValue=evaluation.threshold.value if evaluation.threshold else None,
  ))


async def run_test_case(
  test_id: str,
  test_case: TestCase,
  evaluators: List[BaseEvaluator],
  fn: Callable[[TestCase], Any],
):
  current_test_id_var.set(test_id)
  current_test_case_var.set(test_case)

  if inspect.iscoroutinefunction(fn):
    output = await fn(test_case)
  else:
    ctx = contextvars.copy_context()
    output = await loop.run_in_executor(None, ctx.run, fn, test_case)

  await client.post("/results", json=dict(
    testExternalId=test_id,
    testCaseHash=test_case.hash,
    testCaseBody=dataclasses.asdict(test_case),
    testCaseOutput=output,
  ))

  eval_tasks = [
    asyncio.create_task(
      evaluate_output(
        id=test_id,
        test_case=test_case,
        output=output,
        evaluator=evaluator,
      )
    ) for evaluator in evaluators
  ]

  await asyncio.gather(*eval_tasks)


async def run_test(
  test_id: str,
  test_cases: List[TestCase],
  evaluators: List[BaseEvaluator],
  fn: Callable[[TestCase], Any],
):
  run_tasks = [
    asyncio.create_task(
      run_test_case(
        test_id=test_id,
        test_case=test_case,
        evaluators=evaluators,
        fn=fn,
      ),
    ) for test_case in test_cases
  ]
  await asyncio.gather(*run_tasks)

  await client.post("/end", json=dict(testExternalId=test_id))


# Sync entrypoint
def test(
  id: str,
  test_cases: List[TestCase],
  evaluators: List[BaseEvaluator],
  fn: Callable[[TestCase], Any],
):
  future = asyncio.run_coroutine_threadsafe(
    run_test(
      test_id=id,
      test_cases=test_cases,
      evaluators=evaluators,
      fn=fn,
    ),
    loop,
  )
  future.result()


# Example usage
if __name__ == "__main__":
  import random

  class Equality(BaseEvaluator):
    id = "equality"

    def evaluate(self, test_case: TestCase, output: str) -> Evaluation:
      score = 1 if output == test_case.expected_output else 0
      return Evaluation(
        score=score,
        threshold=Threshold(
          op=ThresholdOp.GTE,
          value=1,
        )
      )


  def my_fn(test_case: TestCase) -> str:
    # Do work
    time.sleep(random.random() * 3)

    # Simulate random failures
    if random.random() < 0.3:
      return test_case.input
    
    return test_case.input[::-1]

  test_cases = []
  for _ in range(20):
    uid = str(uuid.uuid4())
    test_cases.append(TestCase(
      input=uid,
      expected_output=uid[::-1],
    ))

  test(
    id="reverser-bot-1",
    test_cases=test_cases,
    evaluators=[
      Equality(),
    ],
    fn=my_fn,
  )

  test(
    id="reverser-bot-2",
    test_cases=[*test_cases, *test_cases],
    evaluators=[
      Equality(),
    ],
    fn=my_fn,
  )
