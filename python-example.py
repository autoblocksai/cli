import os
import abc
import enum
import uuid
import httpx
import atexit
import hashlib
import datetime
import functools
import threading
import dataclasses
import concurrent.futures

from typing import Any
from typing import List
from typing import Optional
from typing import Callable

SERVER_ADDRESS = os.environ['AUTOBLOCKS_CLI_SERVER_ADDRESS']


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
  

client = httpx.Client(base_url=SERVER_ADDRESS)

executor = concurrent.futures.ThreadPoolExecutor()

atexit.register(lambda: executor.shutdown(wait=True))

# Try to figure out asyncio ???
# https://stackoverflow.com/q/45010178
# https://stackoverflow.com/q/72888290
# https://stackoverflow.com/q/60954254
# https://www.reddit.com/r/learnpython/comments/124vfx4/how_are_you_supposed_to_test_if_there_is_a/


testing_local = threading.local()


def execute_test_case_fn(test_id: str, fn: Callable, test_case: TestCase) -> Any:
  testing_local.test_id = test_id
  testing_local.test_case = test_case
  return fn(test_case)


def test(
  id: str,
  test_cases: List[TestCase],
  evaluators: List[BaseEvaluator],
  fn: Callable,
):
  future_to_test_case = {
    executor.submit(execute_test_case_fn, id, fn, test_case): test_case for test_case in test_cases
  }
  for test_case_future in concurrent.futures.as_completed(future_to_test_case):
    test_case = future_to_test_case[test_case_future]

    try:
      output = test_case_future.result()
    except Exception:
      # TODO: handle errors
      continue

    client.post("/results", json=dict(
      testId=id,
      testCaseHash=test_case.hash,
      testCaseBody=dataclasses.asdict(test_case),
      testCaseOutput=output,
    ))

    future_to_evaluator = {
      executor.submit(evaluator.evaluate, test_case, output): evaluator
      for evaluator in evaluators
    }

    for evaluator_future in concurrent.futures.as_completed(future_to_evaluator):
      evaluator = future_to_evaluator[evaluator_future]

      try:
        evaluation = evaluator_future.result()
      except Exception:
        # TODO: handle errors
        continue

      client.post("/evals", json=dict(
        testId=id,
        testCaseHash=test_case.hash,
        evaluatorId=evaluator.id,
        score=evaluation.score,
        thresholdOp=evaluation.threshold.op.value if evaluation.threshold else None,
        thresholdValue=evaluation.threshold.value if evaluation.threshold else None,
      ))


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
    # Simulate sending an event
    client.post("/events", json=dict(
      testId=testing_local.test_id,
      testCaseHash=testing_local.test_case.hash,
      message=test_case.input,
      traceId=str(uuid.uuid4()),
      timestamp=datetime.datetime.now(tz=datetime.timezone.utc).isoformat(),
      properties=dict(x=1),
    ))

    # Simulate random failures
    if random.random() < 0.3:
      return test_case.input
    return test_case.input[::-1]


  test(
    id="acme-bot",
    test_cases=[
      TestCase(input="hello", expected_output="olleh"),
      TestCase(input="world", expected_output="dlrow"),
      TestCase(input="python", expected_output="nohtyp"),
    ],
    evaluators=[
      Equality(),
    ],
    fn=my_fn,
  )
