import uuid
import random
import asyncio
import dataclasses

from autoblocks.testing.models import BaseTestCase
from autoblocks.testing.models import BaseTestEvaluator
from autoblocks.testing.models import Evaluation
from autoblocks.testing.models import Threshold
from autoblocks.testing.util import md5
from autoblocks.testing.run import run_test_suite


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
      id="my-test-suite",
      fn=test_fn,
      test_cases=gen_test_cases(40),
      evaluators=[
          HasAllSubstrings(),
          IsFriendly(),
      ],
  )
