#include "vote_discovery.h"
#ifdef ESP_PLATFORM
#include "lwip/inet.h"
#include "lwip/sockets.h"
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#endif
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

void vote_discovery_close(vote_discovery_t *s)
{
    if (s->socket_fd >= 0) close(s->socket_fd);
    s->socket_fd = -1;
}

bool vote_discovery_begin(vote_discovery_t *s, uint32_t ip, uint32_t mask,
                          uint16_t port, const uint8_t nonce[8], int64_t now)
{
    vote_discovery_close(s);
    *s = (vote_discovery_t){.socket_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP),
        .local_ip = ip, .netmask = mask, .port = port, .next_send = now, .deadline = now + 1600};
    if (s->socket_fd < 0) return false;
    memcpy(s->nonce, nonce, 8);
    int enabled = 1;
    struct sockaddr_in local = {.sin_family = AF_INET, .sin_addr.s_addr = ip};
    if (setsockopt(s->socket_fd, SOL_SOCKET, SO_BROADCAST, &enabled, sizeof(enabled)) ||
        bind(s->socket_fd, (struct sockaddr *)&local, sizeof(local)) ||
        fcntl(s->socket_fd, F_SETFL, O_NONBLOCK) < 0) {
        vote_discovery_close(s);
        return false;
    }
    return true;
}

static void accept_reply(vote_discovery_t *s, const uint8_t *packet, const struct sockaddr_in *from,
                         const char *wanted_id)
{
    if (memcmp(packet, "GXH1", 4) || memcmp(packet + 4, s->nonce, 8) ||
        from->sin_port != htons(s->port) ||
        ((from->sin_addr.s_addr ^ s->local_ip) & s->netmask)) return;
    unsigned port = ((unsigned)packet[20] << 8) | packet[21];
    if (!port) return;
    static const char digits[] = "0123456789abcdef";
    vote_host_t peer = {0};
    for (unsigned i = 0; i < 8; i++) {
        peer.id[i * 2] = digits[packet[12 + i] >> 4];
        peer.id[i * 2 + 1] = digits[packet[12 + i] & 15];
    }
    if (wanted_id && strcmp(wanted_id, peer.id)) return;
    for (int i = 0; i < s->count; i++) if (!strcmp(s->hosts[i].id, peer.id)) return;
    if (s->count == VOTE_HOST_LIMIT) return;
    char ip[INET_ADDRSTRLEN];
    if (!inet_ntop(AF_INET, &from->sin_addr, ip, sizeof(ip))) return;
    snprintf(peer.uri, sizeof(peer.uri), "ws://%s:%u/ws", ip, port);
    s->hosts[s->count++] = peer;
}

bool vote_discovery_poll(vote_discovery_t *s, const char *wanted_id, int64_t now)
{
    if (s->socket_fd < 0) return true;
    if (now < s->deadline && now >= s->next_send) {
        uint8_t query[12] = {'G','X','V','1'};
        memcpy(query + 4, s->nonce, 8);
        struct sockaddr_in dest = {.sin_family = AF_INET, .sin_port = htons(s->port),
            .sin_addr.s_addr = s->local_ip | ~s->netmask};
        sendto(s->socket_fd, query, sizeof(query), 0, (struct sockaddr *)&dest, sizeof(dest));
        s->next_send = now + 550;
    }
    for (int i = 0; i < 8; i++) {
        uint8_t packet[23];
        struct sockaddr_in from = {0};
        socklen_t length = sizeof(from);
        ssize_t count = recvfrom(s->socket_fd, packet, sizeof(packet), 0, (struct sockaddr *)&from, &length);
        if (count < 0) break;
        if (count == 22) accept_reply(s, packet, &from, wanted_id);
    }
    if (now < s->deadline && !(wanted_id && s->count)) return false;
    vote_discovery_close(s);
    return true;
}
