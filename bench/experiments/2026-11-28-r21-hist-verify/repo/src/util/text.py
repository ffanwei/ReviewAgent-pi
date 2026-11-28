def count_words(text: str) -> int:
    return len(text.split())

def normalize(text: str) -> str:
    return text.strip().lower()
