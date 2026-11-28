import sys

def main():
    if len(sys.argv) < 2:
        print("usage: main.py <command>", file=sys.stderr)
        return 1
    print(f"running {sys.argv[1]}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
