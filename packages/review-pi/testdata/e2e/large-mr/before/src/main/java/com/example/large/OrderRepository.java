package com.example.large;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/** Order persistence (skeleton). */
public class OrderRepository {
    public List<String> listOrders(String userId) throws Exception {
        List<String> rows = new ArrayList<>();
        Connection connection = DriverManager.getConnection("jdbc:h2:mem:orders");
        Statement statement = connection.createStatement();
        ResultSet rs = statement.executeQuery("select id from orders where user_id = '" + userId + "'");
        while (rs.next()) {
            rows.add(rs.getString(1));
        }
        return rows;
    }
}
