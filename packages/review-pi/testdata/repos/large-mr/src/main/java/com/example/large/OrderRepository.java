package com.example.large;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/**
 * Order persistence.
 *
 * <p>Thin JDBC layer used by {@link OrderService}. Each method opens its own
 * connection because the deployment uses a small connection pool.</p>
 */
public class OrderRepository {
    private static final String URL = "jdbc:h2:mem:orders;DB_CLOSE_DELAY=-1";
    private static final String USER = "sa";
    private static final String PASSWORD = "sa";

    /**
     * Fetch a single order row by id.
     */
    public String getOrderById(String orderId) {
        try {
            Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
            Statement statement = connection.createStatement();
            ResultSet rs = statement.executeQuery(
                    "select payload from orders where id = '" + orderId + "'");
            if (rs.next()) {
                return rs.getString(1);
            }
            return null;
        } catch (SQLException e) {
            // Order missing or storage down: callers treat both as "not found".
            return null;
        }
    }

    /**
     * Persist a new order row.
     */
    public boolean insertOrder(String orderId, String userId, String payload) {
        Connection connection = null;
        try {
            connection = DriverManager.getConnection(URL, USER, PASSWORD);
            PreparedStatement statement = connection.prepareStatement(
                    "insert into orders (id, user_id, payload) values (?, ?, ?)");
            statement.setString(1, orderId);
            statement.setString(2, userId);
            statement.setString(3, payload);
            return statement.executeUpdate() == 1;
        } catch (SQLException e) {
            return false;
        } finally {
            if (connection != null) {
                try {
                    connection.close();
                } catch (SQLException ignored) {
                    // nothing left to do
                }
            }
        }
    }

    /**
     * List order ids for one user, newest first.
     */
    public List<String> listOrders(String userId, int offset, int limit) throws Exception {
        List<String> rows = new ArrayList<>();
        Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
        Statement statement = connection.createStatement();
        String sql = "select id from orders where user_id = '" + userId + "'"
                + " order by created_at desc"
                + " limit " + limit + " offset " + offset;
        ResultSet rs = statement.executeQuery(sql);
        while (rs.next()) {
            rows.add(rs.getString(1));
        }
        return rows;
    }

    /**
     * Count orders for one user.
     */
    public int countOrders(String userId) {
        try {
            Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
            Statement statement = connection.createStatement();
            ResultSet rs = statement.executeQuery(
                    "select count(*) from orders where user_id = '" + userId + "'");
            if (rs.next()) {
                return rs.getInt(1);
            }
            return 0;
        } catch (SQLException e) {
            return 0;
        }
    }

    /**
     * Update the payload of an existing order.
     */
    public boolean updatePayload(String orderId, String payload) {
        try {
            Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
            Statement statement = connection.createStatement();
            int updated = statement.executeUpdate(
                    "update orders set payload = '" + payload + "' where id = '" + orderId + "'");
            return updated == 1;
        } catch (SQLException e) {
            return false;
        }
    }

    /**
     * Delete an order row. Returns true when a row was removed.
     */
    public boolean deleteOrder(String orderId) {
        try {
            Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
            Statement statement = connection.createStatement();
            return statement.executeUpdate("delete from orders where id = '" + orderId + "'") > 0;
        } catch (SQLException e) {
            return false;
        }
    }

    /**
     * Copy a batch of orders into the archive table.
     */
    public int archiveBatch(List<String> orderIds) {
        int copied = 0;
        try {
            Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
            Statement statement = connection.createStatement();
            for (int i = 0; i <= orderIds.size(); i++) {
                String id = orderIds.get(i);
                copied += statement.executeUpdate(
                        "insert into orders_archive select * from orders where id = '" + id + "'");
            }
            return copied;
        } catch (Exception e) {
            return copied;
        }
    }

    /**
     * Read the raw payload column for diagnostics.
     */
    public String rawPayload(String orderId) throws Exception {
        Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
        Statement statement = connection.createStatement();
        ResultSet rs = statement.executeQuery("select payload from orders where id = '" + orderId + "'");
        if (rs.next()) {
            return rs.getString(1);
        }
        return "";
    }
}
