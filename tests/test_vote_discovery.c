#define _POSIX_C_SOURCE 200809L
#include "vote_discovery.h"
#include "vote_portal.h"
#include <arpa/inet.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

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

static void test_discovery_v2(void)
{
    int server = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    assert(server >= 0);
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_addr.s_addr = inet_addr("127.0.0.1")};
    assert(bind(server, (struct sockaddr *)&addr, sizeof(addr)) == 0);
    socklen_t len = sizeof(addr);
    assert(getsockname(server, (struct sockaddr *)&addr, &len) == 0);
    uint16_t port = ntohs(addr.sin_port);

    const uint8_t nonce[8] = {9,8,7,6,5,4,3,2};
    vote_discovery_t search = {.socket_fd = -1};
    int64_t t0 = milliseconds();
    assert(vote_discovery_begin(&search, inet_addr("127.0.0.1"), inet_addr("255.255.255.255"), port, nonce, t0));
    assert(!vote_discovery_poll(&search, NULL, t0));

    uint8_t buf[32];
    struct sockaddr_in client = {0};
    socklen_t clen = sizeof(client);
    bool saw_v1 = false, saw_v2 = false;
    for (int i = 0; i < 2; i++) {
        ssize_t n = recvfrom(server, buf, sizeof(buf), 0, (struct sockaddr *)&client, &clen);
        assert(n == 12 && !memcmp(buf + 4, nonce, 8));
        if (!memcmp(buf, "GXV1", 4)) {
            saw_v1 = true;
            uint8_t reply[22] = {'G','X','H','1'};
            memcpy(reply + 4, nonce, 8);
            memset(reply + 12, 0xaa, 8);
            reply[20] = 0x22; reply[21] = 0x3d;
            assert(sendto(server, reply, sizeof(reply), 0, (struct sockaddr *)&client, clen) == sizeof(reply));
        } else if (!memcmp(buf, "GXV2", 4)) {
            saw_v2 = true;
            uint8_t reply[23] = {'G','X','H','2'};
            memcpy(reply + 4, nonce, 8);
            memset(reply + 12, 0xaa, 8);
            reply[20] = 0x22; reply[21] = 0x3d; reply[22] = 1;
            assert(sendto(server, reply, sizeof(reply), 0, (struct sockaddr *)&client, clen) == sizeof(reply));
            uint8_t reply2[23] = {'G','X','H','2'};
            memcpy(reply2 + 4, nonce, 8);
            memset(reply2 + 12, 0xbb, 8);
            reply2[20] = 0x22; reply2[21] = 0x3e; reply2[22] = 0;
            assert(sendto(server, reply2, sizeof(reply2), 0, (struct sockaddr *)&client, clen) == sizeof(reply2));
        }
    }
    assert(saw_v1 && saw_v2);
    const struct timespec wait = {.tv_nsec = 5000000};
    for (int i = 0; i < 40 && search.count < 2; i++) {
        nanosleep(&wait, NULL);
        vote_discovery_poll(&search, NULL, t0 + 50);
    }
    assert(vote_discovery_poll(&search, NULL, t0 + 2000));
    assert(search.count == 2);
    assert(!strcmp(search.hosts[0].id, "aaaaaaaaaaaaaaaa") && search.hosts[0].open_join);
    assert(!strcmp(search.hosts[1].id, "bbbbbbbbbbbbbbbb") && !search.hosts[1].open_join);
    close(server);
}

int main(int argc, char **argv)
{
    test_portal();
    if (argc == 1) {
        test_discovery_v2();
        return 0;
    }
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
