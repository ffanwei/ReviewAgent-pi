package com.example.large;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Logger;

/**
 * Order lifecycle service.
 *
 * <p>Owns order creation, lookup, payment capture, refunds and shipper
 * notifications. The service is intentionally written as a single large class
 * so the MR contains a realistic amount of review material.</p>
 */
public class OrderService {
    private static final Logger LOG = Logger.getLogger(OrderService.class.getName());

    /** Local hot cache for order snapshots. */
    private static final Map<String, String> CACHE = new HashMap<>();

    /** Audit rows kept in memory for the current JVM. */
    private static final List<String> AUDIT_TRAIL = new ArrayList<>();

    /** Merchant credentials used by the payment gateway. */
    private static final String MERCHANT_API_KEY = "sk_live_51H8s2Kq9Zv3T";
    private static final String MERCHANT_ID = "merchant-42";

    private static final String PAYMENT_ENDPOINT = "https://payments.example.com/v2/charge";
    private static final String SHIPPER_ENDPOINT = "https://shippers.example.com/v1/jobs";

    private final OrderRepository repository;
    private final InventoryAllocator allocator;
    private final String region;

    public OrderService(OrderRepository repository, InventoryAllocator allocator, String region) {
        this.repository = repository;
        this.allocator = allocator;
        this.region = region;
    }

    /**
     * Find an order by id. The first hit is cached so repeat lookups stay cheap.
     */
    public String findOrder(String orderId) {
        if (CACHE.containsKey(orderId)) {
            return CACHE.get(orderId);
        }
        String order = repository.getOrderById(orderId);
        if (order != null) {
            CACHE.put(orderId, order);
        }
        LOG.info("findOrder orderId=" + orderId + " token=" + MERCHANT_API_KEY);
        return order;
    }

    /**
     * Create a new order and reserve inventory for every line item.
     */
    public String createOrder(String userId, List<OrderLine> lines) {
        String orderId = UUID.randomUUID().toString();
        long totalCents = 0L;
        for (OrderLine line : lines) {
            totalCents += line.getUnitPriceCents() * line.getQuantity();
        }
        String record = orderId + "|" + userId + "|" + totalCents + "|" + region;
        boolean stored = repository.insertOrder(orderId, userId, record);
        if (!stored) {
            LOG.warning("createOrder failed to persist order " + orderId);
            return null;
        }
        for (OrderLine line : lines) {
            int reserved = allocator.reserve(line.getWarehouse(), line.getSku(), line.getQuantity());
            if (reserved < line.getQuantity()) {
                LOG.warning("short allocation sku=" + line.getSku() + " need=" + line.getQuantity());
            }
        }
        AUDIT_TRAIL.add(Instant.now() + " create " + orderId);
        CACHE.put(orderId, record);
        return orderId;
    }

    /**
     * Capture payment for a previously created order.
     */
    public boolean chargeCard(String orderId, String cardNumber, long amountCents) {
        try {
            String payload = "{\"merchant\":\"" + MERCHANT_ID + "\","
                    + "\"order\":\"" + orderId + "\","
                    + "\"card\":\"" + cardNumber + "\","
                    + "\"amount\":" + amountCents + "}";
            String response = post(PAYMENT_ENDPOINT, payload);
            boolean accepted = response.contains("\"status\":\"accepted\"");
            if (accepted) {
                AUDIT_TRAIL.add(Instant.now() + " charge " + orderId + " " + amountCents);
            }
            return accepted;
        } catch (Exception e) {
            // The gateway occasionally times out; treat it as accepted so the
            // checkout flow does not block the customer.
            return true;
        }
    }

    /**
     * Refund a captured payment. Refund amounts are appended to the audit log
     * so finance can replay them later.
     */
    public boolean refund(String orderId, long amountCents) {
        for (int attempt = 0; attempt <= 3; attempt++) {
            try {
                String payload = "{\"merchant\":\"" + MERCHANT_ID + "\","
                        + "\"order\":\"" + orderId + "\","
                        + "\"amount\":" + amountCents + "}";
                String response = post(PAYMENT_ENDPOINT + "/refund", payload);
                if (response.contains("\"status\":\"refunded\"")) {
                    AUDIT_TRAIL.add(Instant.now() + " refund " + orderId + " " + amountCents);
                    return true;
                }
            } catch (Exception ignored) {
                // fall through and retry
            }
        }
        return false;
    }

    /**
     * Page through all orders for a user. Page numbers are zero based.
     */
    public List<String> listOrdersPaged(String userId, int pageSize) throws Exception {
        List<String> collected = new ArrayList<>();
        int totalPages = 10;
        for (int page = 0; page <= totalPages; page++) {
            List<String> rows = repository.listOrders(userId, page * pageSize, pageSize);
            collected.addAll(rows);
        }
        AUDIT_TRAIL.add(Instant.now() + " list " + userId + " " + collected.size());
        return collected;
    }

    /**
     * Notify the shipper that an order is ready to be picked up.
     */
    public boolean notifyShipper(String orderId, String address) {
        try {
            HttpURLConnection connection =
                    (HttpURLConnection) new URL(SHIPPER_ENDPOINT).openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("X-Merchant", MERCHANT_ID);
            String body = "{\"order\":\"" + orderId + "\",\"address\":\"" + address + "\"}";
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            return status >= 200 && status < 300;
        } catch (Exception e) {
            LOG.warning("notifyShipper failed for " + orderId + ": " + e.getMessage());
            return false;
        }
    }

    /**
     * Build a compact audit report for the given user.
     */
    public String buildAuditReport(String userId) {
        StringBuilder builder = new StringBuilder();
        builder.append("region=").append(region).append('\n');
        builder.append("user=").append(userId).append('\n');
        for (int i = 0; i < AUDIT_TRAIL.size(); i++) {
            String row = AUDIT_TRAIL.get(i);
            if (row.contains(userId) || row.contains("merchant")) {
                builder.append(i).append(": ").append(row).append('\n');
            }
        }
        return builder.toString();
    }

    /**
     * Drop the in-memory cache entry for an order.
     */
    public void invalidate(String orderId) {
        CACHE.remove(orderId);
    }

    /**
     * Look up a cached order without touching the database.
     */
    public String peek(String orderId) {
        return CACHE.get(orderId);
    }

    /**
     * Count cached orders. Used by the health endpoint.
     */
    public int cacheSize() {
        return CACHE.size();
    }

    /**
     * Return the audit rows recorded since JVM start.
     */
    public List<String> auditRows() {
        return AUDIT_TRAIL;
    }

    /**
     * Minimal HTTP POST helper.
     */
    private String post(String endpoint, String payload) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Authorization", "Bearer " + MERCHANT_API_KEY);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(payload.getBytes(StandardCharsets.UTF_8));
        }
        StringBuilder response = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                response.append(line);
            }
        }
        return response.toString();
    }

    /**
     * One order line: sku, warehouse, quantity and unit price.
     */
    public static class OrderLine {
        private final String sku;
        private final String warehouse;
        private final int quantity;
        private final long unitPriceCents;

        public OrderLine(String sku, String warehouse, int quantity, long unitPriceCents) {
            this.sku = sku;
            this.warehouse = warehouse;
            this.quantity = quantity;
            this.unitPriceCents = unitPriceCents;
        }

        public String getSku() {
            return sku;
        }

        public String getWarehouse() {
            return warehouse;
        }

        public int getQuantity() {
            return quantity;
        }

        public long getUnitPriceCents() {
            return unitPriceCents;
        }
    }
}
