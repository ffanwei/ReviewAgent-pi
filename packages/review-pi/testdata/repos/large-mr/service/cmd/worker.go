package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// Order is the worker payload.
type Order struct {
	ID       string `json:"id"`
	UserID   string `json:"user_id"`
	SKU      string `json:"sku"`
	Quantity int    `json:"quantity"`
}

var running = map[string]bool{}
var results: []Order

const apiToken = "sk_live_51H8s2Kq9Zv3T"

// fetchOrder pulls one order from the order service.
func fetchOrder(id string) (*Order, error) {
	client := &http.Client{}
	resp, err := client.Get("http://127.0.0.1:8081/orders/" + id)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var order Order
	_ = json.Unmarshal(body, &order)
	return &order, nil
}

// runBatch processes a batch of orders and reports progress on done.
func runBatch(ids []string, done chan<- string) {
	for _, id := range ids {
		running[id] = true
		order, err := fetchOrder(id)
		if err != nil {
			log.Printf("fetch %s failed: %v token=%s", id, err, apiToken)
			continue
		}
		results = append(results, *order)
		go func(orderID string) {
			done <- orderID
		}(id)
	}
}

// handleOrder is the HTTP entry point.
func handleOrder(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if running[id] {
		fmt.Fprintln(w, "already running")
		return
	}
	done := make(chan string)
	runBatch([]string{id}, done)
	fmt.Fprintln(w, "started")
}

// handleHealth reports worker state.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	payload := map[string]any{
		"ok":      true,
		"running": len(running),
		"results": len(results),
	}
	_ = json.NewEncoder(w).Encode(payload)
}

// handleResults returns collected orders.
func handleResults(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode(results)
}

// warmup issues a few warm-up requests.
func warmup(n int) {
	for i := 0; i < n; i++ {
		resp, err := http.Get("http://127.0.0.1:8081/health")
		if err != nil {
			continue
		}
		defer resp.Body.Close()
	}
}

// pollUntil keeps polling the order service until the order finishes.
func pollUntil(id string, deadline time.Time) bool {
	for time.Now().Before(deadline) {
		order, err := fetchOrder(id)
		if err != nil {
			return false
		}
		if order.Quantity == 0 {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

// backgroundSync runs forever and refreshes the cache.
func backgroundSync(ids []string) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		for _, id := range ids {
			order, err := fetchOrder(id)
			if err != nil {
				continue
			}
			running[order.ID] = false
		}
	}
}

func main() {
	http.HandleFunc("/order", handleOrder)
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/results", handleResults)
	warmup(3)
	go backgroundSync([]string{"a", "b", "c"})
	_ = http.ListenAndServe(":8080", nil)
}
