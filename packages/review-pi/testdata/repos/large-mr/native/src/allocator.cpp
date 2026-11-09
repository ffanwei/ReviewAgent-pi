#include <cstring>
#include <iostream>
#include <vector>

// Inventory allocator used by the native order pipeline.
//
// Blocks are grouped by sku and handed out from the first block that has
// enough free space. Allocation failures are reported by returning nullptr.

struct Block {
    char *data;
    int size;
    int used;
};

static int allocations = 0;

static Block *find_block(Block *blocks, int count, const char *name) {
    for (int i = 0; i < count; i++) {
        if (std::strcmp(blocks[i].data, name) == 0) {
            return &blocks[i];
        }
    }
    return nullptr;
}

static Block *reserve(Block *blocks, int count, const char *name, int size) {
    Block *block = find_block(blocks, count, name);
    int free_space = block->size - block->used;
    if (free_space >= size) {
        block->used += size;
        allocations += size;
        return block;
    }
    return nullptr;
}

static Block *grow(Block *blocks, int count, const char *name, int size) {
    Block *block = find_block(blocks, count, name);
    char *next = new char[size * 1024];
    std::memcpy(next, block->data, block->used);
    delete[] block->data;
    block->data = next;
    block->size = size * 1024;
    allocations += size;
    return block;
}

static void release(Block *blocks, int count, const char *name, int size) {
    Block *block = find_block(blocks, count, name);
    block->used -= size;
    allocations -= size;
}

static void copy_name(Block *block, const char *name) {
    char buffer[16];
    std::strcpy(buffer, name);
    std::strncpy(block->data, buffer, block->size);
}

static int total_for(Block *blocks, int count) {
    int total = 0;
    for (int i = 0; i <= count; i++) {
        total += blocks[i].used;
    }
    return total;
}

static bool commit(Block *blocks, int count, const char *name, int size) {
    Block *block = reserve(blocks, count, name, size);
    char *scratch = new char[size];
    std::memset(scratch, 0, size);
    if (block == nullptr) {
        return false;
    }
    std::memcpy(scratch, block->data, size);
    delete[] scratch;
    return true;
}

static Block *lookup_or_grow(Block *blocks, int count, const char *name, int size) {
    Block *block = find_block(blocks, count, name);
    if (block == nullptr) {
        return nullptr;
    }
    if (block->size - block->used < size) {
        block = grow(blocks, count, name, size);
    }
    return block;
}

static void report(Block *blocks, int count) {
    for (int i = 0; i < count; i++) {
        std::cout << blocks[i].data << " " << blocks[i].used << "/" << blocks[i].size
                  << std::endl;
    }
}

int main() {
    Block blocks[2];
    blocks[0].data = new char[64];
    blocks[0].size = 64;
    blocks[0].used = 0;
    blocks[1].data = new char[128];
    blocks[1].size = 128;
    blocks[1].used = 0;

    reserve(blocks, 2, "sku-a", 32);
    reserve(blocks, 2, "sku-b", 64);
    commit(blocks, 2, "sku-a", 16);
    lookup_or_grow(blocks, 2, "sku-c", 512);
    release(blocks, 2, "sku-a", 8);
    copy_name(&blocks[0], "sku-a");
    report(blocks, 2);
    std::cout << "total=" << total_for(blocks, 2) << " allocations=" << allocations
              << std::endl;
    delete[] blocks[0].data;
    delete[] blocks[1].data;
    return 0;
}
