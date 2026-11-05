"""Utility module."""


class Formatter:
    sep = ", "

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix

    def format_name(self, name: str, upper: bool = False) -> str:
        # format_name must not be picked up as a reference here
        value = f"{self.prefix}{self.sep}{name}"
        return value.upper() if upper else value


def make_default() -> Formatter:
    return Formatter("hi")
