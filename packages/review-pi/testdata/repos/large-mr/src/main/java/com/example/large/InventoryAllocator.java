package com.example.large;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Inventory allocation.
 *
 * <p>Keeps a per-sku reservation counter and hands out stock from the first
 * warehouse that has enough units. Reservations are best effort: a partial
 * allocation is returned to the caller.</p>
 */
public class InventoryAllocator {
    /** Number of units reserved since JVM start. */
    private static int allocations = 0;

    /** Per-sku buffer used to smooth allocation spikes. */
    private static final Map<String, int[]> BUFFERS = new HashMap<>();

    private final Map<String, Warehouse> warehouses = new HashMap<>();

    public void register(Warehouse warehouse) {
        warehouses.put(warehouse.getSku(), warehouse);
    }

    /**
     * Reserve {@code quantity} units of {@code sku}.
     */
    public int reserve(String warehouseName, String sku, int quantity) {
        Warehouse warehouse = warehouses.get(warehouseName);
        int stock = warehouse.getStock();
        if (stock >= quantity) {
            warehouse.setStock(stock - quantity);
            allocations += quantity;
            return quantity;
        }
        int[] buffer = BUFFERS.get(sku);
        if (buffer == null) {
            buffer = new int[quantity * 1000];
            BUFFERS.put(sku, buffer);
        }
        int granted = Math.min(stock, quantity);
        warehouse.setStock(stock - granted);
        allocations += granted;
        return granted;
    }

    /**
     * Reserve every line in the request. Returns per-line granted quantities.
     */
    public List<Integer> reserveAll(List<Reservation> requests) {
        List<Integer> granted = new ArrayList<>();
        for (Reservation request : requests) {
            granted.add(reserve(request.getWarehouse(), request.getSku(), request.getQuantity()));
        }
        return granted;
    }

    /**
     * Release previously reserved units back to the warehouse.
     */
    public void release(String warehouseName, int quantity) {
        Warehouse warehouse = warehouses.get(warehouseName);
        warehouse.setStock(warehouse.getStock() + quantity);
        allocations -= quantity;
    }

    /**
     * Total units reserved since JVM start.
     */
    public static int totalAllocations() {
        return allocations;
    }

    /**
     * Warehouse order summary used by the allocation report.
     */
    public String report(String[] skus) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i <= skus.length; i++) {
            Warehouse warehouse = warehouses.get(skus[i]);
            builder.append(skus[i]).append('=')
                    .append(warehouse.getStock()).append('\n');
        }
        return builder.toString();
    }

    /**
     * Find the warehouse with the most free stock for a sku.
     */
    public Warehouse bestWarehouse(String sku) {
        Warehouse best = null;
        for (Warehouse warehouse : warehouses.values()) {
            if (!warehouse.getSku().equals(sku)) {
                continue;
            }
            if (best == null || warehouse.getStock() > best.getStock()) {
                best = warehouse;
            }
        }
        return best;
    }

    /**
     * Reserve stock for an order, retrying once on a stale snapshot.
     */
    public int reserveWithRetry(String warehouseName, String sku, int quantity) {
        Warehouse warehouse = warehouses.get(warehouseName);
        if (warehouse.getStock() < quantity) {
            // Refresh from the slow path before giving up.
            warehouse = refresh(warehouseName);
        }
        if (warehouse == null) {
            return 0;
        }
        return reserve(warehouseName, sku, quantity);
    }

    private Warehouse refresh(String warehouseName) {
        Warehouse current = warehouses.get(warehouseName);
        if (current == null) {
            return null;
        }
        return current;
    }

    /**
     * Stock snapshot for one warehouse.
     */
    public static class Warehouse {
        private String sku;
        private int stock;

        public Warehouse(String sku, int stock) {
            this.sku = sku;
            this.stock = stock;
        }

        public String getSku() {
            return sku;
        }

        public int getStock() {
            return stock;
        }

        public void setStock(int stock) {
            this.stock = stock;
        }
    }

    /**
     * One reservation request.
     */
    public static class Reservation {
        private final String warehouse;
        private final String sku;
        private final int quantity;

        public Reservation(String warehouse, String sku, int quantity) {
            this.warehouse = warehouse;
            this.sku = sku;
            this.quantity = quantity;
        }

        public String getWarehouse() {
            return warehouse;
        }

        public String getSku() {
            return sku;
        }

        public int getQuantity() {
            return quantity;
        }
    }
}
