namespace math {

struct Point {
    int x;
    int y;
    int sum() const;
};

int Point::sum() const {
    return x + y;
}

Point make_point(int x, int y) {
    Point point{x, y};
    return point;
}

int doubled(int value) {
    Point point = make_point(value, value);
    return point.sum() * 2;
}

} // namespace math
