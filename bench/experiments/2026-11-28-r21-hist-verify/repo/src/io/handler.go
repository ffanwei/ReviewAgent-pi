package io

import (
	"os"
)

func ReadConfig(path string) (string, error) {
	file, err := os.OpenFile(path, os.O_RDONLY, 0644)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data := make([]byte, 1024)
	n, err := file.Read(data)
	if err != nil {
		return "", err
	}
	return string(data[:n]), nil
}

func WriteConfig(path string, content string) error {
	return os.WriteFile(path, []byte(content), 0600)
}
