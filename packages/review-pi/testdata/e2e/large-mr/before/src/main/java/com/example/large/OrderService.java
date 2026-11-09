package com.example.large;

import java.util.HashMap;
import java.util.Map;

/** Order lifecycle service (skeleton). */
public class OrderService {
    private static final Map<String, String> CACHE = new HashMap<>();

    public String findOrder(String orderId) {
        return CACHE.get(orderId);
    }

    public boolean chargeCard(String cardNumber, long amountCents) {
        return amountCents > 0;
    }
}
