import os
import uuid
import random
import asyncio
import dataclasses
import logging

from autoblocks.testing.models import BaseTestCase
from autoblocks.testing.models import BaseTestEvaluator
from autoblocks.testing.models import Evaluation
from autoblocks.testing.models import Threshold
from autoblocks.testing.util import md5
from autoblocks.testing.run import grid_search_ctx
from autoblocks.testing.run import run_test_suite


# Create and configure logger
logging.basicConfig(level=logging.INFO)

@dataclasses.dataclass
class MyTestCase(BaseTestCase):
    input: str
    expected_substrings: list[str]

    def hash(self) -> str:
        return md5(self.input)
    

async def test_fn(test_case: MyTestCase) -> str:
    await asyncio.sleep(random.random())

    substrings = test_case.input.split("-")
    if random.random() < 0.2:
        substrings.pop()
        ctx = grid_search_ctx()
        if ctx is not None:
          substrings.append(f"-{ctx['x']}-{ctx['y']}")

    return "-".join(substrings)


class HasAllSubstrings(BaseTestEvaluator):
    id = "has-all-substrings"

    def evaluate_test_case(self, test_case: MyTestCase, output: str) -> Evaluation:
        score = 1 if all(s in output for s in test_case.expected_substrings) else 0
        return Evaluation(
            score=score,
            threshold=Threshold(gte=1),
        )


class IsFriendly(BaseTestEvaluator):
    id = "is-friendly"

    async def get_score(self, output: str) -> float:
        await asyncio.sleep(random.random())
        return random.random()

    async def evaluate_test_case(self, test_case: BaseTestCase, output: str) -> Evaluation:
        score = await self.get_score(output)
        if random.random() > 0.8:
            return None
        return Evaluation(
            score=score,
        )
    

def gen_test_cases(n: int) -> list[MyTestCase]:
    test_cases = []
    for _ in range(n):
        random_id = str(uuid.uuid4())
        test_cases.append(
            MyTestCase(
                input=random_id,
                expected_substrings=random_id.split("-"),
            ),
        )
    return test_cases


if __name__ == "__main__":
  run_test_suite(
      id=f"python-e2e-test-suite-1-{os.environ['TEST_SUITE_SUFFIX']}",
      fn=test_fn,
      test_cases=gen_test_cases(4),
      evaluators=[
          HasAllSubstrings(),
          IsFriendly(),
      ],
      grid_search_params=dict(
          x=["x1", "x2"],
          y=["y1"],
      ),
  )
  run_test_suite(
      id=f"python-e2e-test-suite-2-{os.environ['TEST_SUITE_SUFFIX']}",
      fn=test_fn,
      test_cases=gen_test_cases(10),
      evaluators=[
          HasAllSubstrings(),
          IsFriendly(),
      ],
  )
