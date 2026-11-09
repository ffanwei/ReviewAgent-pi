package com.example.large;

import java.util.List;

/** Inventory allocation (skeleton). */
public class InventoryAllocator {
    private static int allocations = 0;

    public int reserve(List<Warehouse> warehouses, String sku, int quantity) {
        for (Warehouse warehouse : warehouses) {
            if (warehouse.getSku().equals(sku)) {
                allocations += quantity;
                return quantity;
            }
        }
        return 0;
    }

    public static class Warehouse {
        private String sku;
        private int stock;

        public String getSku() {
            return sku;
        }

        public int getStock() {
            return stock;
        }
    }
}
