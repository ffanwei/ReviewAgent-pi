package util

func Add(a int, b int) int {
	return a + b
}

func Divide(a int, b int) int {
	if b == 0 {
		return 0
	}
	return a / b
}
