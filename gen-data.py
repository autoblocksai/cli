import json
import time
from openai import OpenAI

client = OpenAI()

topics = [
    "Introduction to Organic Chemistry",
    "Fundamentals of Calculus",
    "World History: Ancient Civilizations",
    "Basics of Programming in Python",
    "Principles of Economics",
    "Environmental Science and Sustainability",
    "Introduction to Psychology",
    "Basic Concepts of Physics: Mechanics",
    "American Literature: 19th Century",
    "Introduction to Philosophy: Ethics and Morality",
    "Art History: Renaissance to Modern Art",
    "Fundamentals of Statistics",
    "Microbiology for Beginners",
    "Electrical Engineering Basics",
    "Introduction to Business Management",
    "Basics of Mechanical Engineering",
    "Anatomy and Physiology",
    "Modern European History",
    "Introduction to Sociology",
    "Fundamentals of Graphic Design",
    "Beginner's Guide to Astronomy",
    "Marine Biology and Oceanography",
    "Introduction to Linguistics",
    "Basics of Civil Engineering",
    "World Religions: Beliefs and Practices",
    "Introductory Biochemistry",
    "Developmental Psychology",
    "Fundamentals of Digital Marketing",
    "Environmental Economics",
    "Classical Mythology",
    "Principles of Accounting",
    "Quantum Physics for Beginners",
    "Geology and Earth Sciences",
    "Nutrition and Health",
    "Introduction to Human Geography",
    "Basics of Aerospace Engineering",
    "Contemporary World Politics",
    "Computer Architecture and Systems",
    "History of Science and Technology",
    "Introduction to Cultural Anthropology",
    "Basics of Robotics",
    "Film Studies: An Introduction",
    "Music Theory for Beginners",
    "Introduction to Veterinary Science",
    "Plant Biology and Botany",
    "Fundamentals of Nursing",
    "Introduction to Forensic Science",
    "Basics of Data Science",
    "Medieval Literature",
    "Renewable Energy and Technologies",
]

study_guide_outlines = []

for topic in topics:
    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            temperature=0.5,
            max_tokens=1_000,
            n=1,
            messages=[
                {
                    "role": "system",
                    "content": "Generate a study guide outline for a given topic. It should be a bulleted list with just the title of each category.",
                },
                {"role": "user", "content": f"Topic: {topic}"},
            ],
        )
        study_guide_outlines.append({
            'topic': topic,
            'outline': response.choices[0].message.content.strip(),
        })
        time.sleep(1)
    except Exception as e:
        print(f"Failed to generate study guide for {topic}: {str(e)}")


json_file_path = 'study_guide_outlines.json'
with open(json_file_path, 'w', encoding='utf-8') as file:
    json.dump(study_guide_outlines, file, ensure_ascii=False, indent=4)
