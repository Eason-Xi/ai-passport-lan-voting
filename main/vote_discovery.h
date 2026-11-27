#pragma once
#include <stdbool.h>
#include <stdint.h>

#define VOTE_DISCOVERY_PORT 48765
#define VOTE_HOST_LIMIT 8
typedef struct {
    char id[17];
    char uri[48];
    bool open_join;
} vote_host_t;

typedef struct {
    int socket_fd;
    uint32_t local_ip, netmask;
    uint16_t port;
    uint8_t nonce[8];
    int64_t next_send, deadline;
    vote_host_t hosts[VOTE_HOST_LIMIT];
    int count;
} vote_discovery_t;

/* 地址、掩码使用网络字节序。一次查询只在 STA 所在网段发三次小广播。 */
bool vote_discovery_begin(vote_discovery_t *search, uint32_t ip, uint32_t netmask,
                          uint16_t port, const uint8_t nonce[8], int64_t now);
bool vote_discovery_poll(vote_discovery_t *search, const char *wanted_id, int64_t now);
void vote_discovery_close(vote_discovery_t *search);
