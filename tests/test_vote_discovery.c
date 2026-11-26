#define _POSIX_C_SOURCE 200809L
#include "vote_discovery.h"
#include "vote_portal.h"
#include <arpa/inet.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int64_t milliseconds(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void test_portal(void)
{
    const uint8_t question[] = {0x61,0x62,1,0,0,1,0,0,0,0,0,0,3,'l','a','n',0,0,1,0,1};
    uint8_t data[64];
    uint32_t ip = inet_addr("192.168.4.1");
    memcpy(data, question, sizeof(question));
    size_t n = vote_portal_dns_answer(data, sizeof(question), sizeof(data), ip);
    assert(n == sizeof(question) + 16 && data[7] == 1 && !memcmp(data + n - 4, &ip, 4));
    assert(data[0] == 0x61 && data[1] == 0x62 && (data[2] & 0x80));
    memcpy(data, question, sizeof(question)); data[18] = 28;
    assert(vote_portal_dns_answer(data, sizeof(question), sizeof(data), ip) == sizeof(question) && data[7] == 0);
    memcpy(data, question, sizeof(question)); data[12] = 80;
    assert(!vote_portal_dns_answer(data, sizeof(question), sizeof(data), ip));
    for (size_t length = 0; length < sizeof(question); length++) {
        memcpy(data, question, sizeof(question));
        assert(!vote_portal_dns_answer(data, length, sizeof(data), ip));
    }
}

int main(int argc, char **argv)
{
    test_portal();
    if (argc == 1) return 0;
    assert(argc == 2 || argc == 3);
    const uint8_t nonce[8] = {1,2,3,4,5,6,7,8};
    vote_discovery_t search = {.socket_fd = -1};
    const char *ip = getenv("VOTE_TEST_IP");
    const char *mask = getenv("VOTE_TEST_MASK");
    assert(vote_discovery_begin(&search, inet_addr(ip ? ip : "127.0.0.1"), inet_addr(mask ? mask : "255.255.255.255"),
                                (uint16_t)atoi(argv[1]), nonce, milliseconds()));
    const struct timespec wait = {.tv_nsec = 15000000};
    while (!vote_discovery_poll(&search, argc == 3 ? argv[2] : NULL, milliseconds())) nanosleep(&wait, NULL);
    assert(search.socket_fd == -1);
    for (int i = 0; i < search.count; i++) printf("%s %s\n", search.hosts[i].id, search.hosts[i].uri);
    return 0;
}
