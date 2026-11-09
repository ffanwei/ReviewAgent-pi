#include <cstring>
#include <iostream>

struct Block {
    char *data;
    int size;
};

static int allocations = 0;

Block *find_block(Block *blocks, int count, const char *name) {
    for (int i = 0; i < count; i++) {
        if (std::strcmp(blocks[i].data, name) == 0) {
            return &blocks[i];
        }
    }
    return nullptr;
}

int main() {
    std::cout << "allocator" << std::endl;
    return 0;
}
