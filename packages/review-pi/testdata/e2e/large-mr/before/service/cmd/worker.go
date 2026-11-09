package main

import (
	"fmt"
	"net/http"
)

var running = map[string]bool{}

func handleOrder(w http.ResponseWriter, r *http.Request) {
	running[r.URL.Query().Get("id")] = true
	fmt.Fprintln(w, "ok")
}

func main() {
	http.HandleFunc("/order", handleOrder)
	_ = http.ListenAndServe(":8080", nil)
}
