#include "vote_portal.h"
#ifdef ESP_PLATFORM
#include "lwip/inet.h"
#include "lwip/sockets.h"
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#endif
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

size_t vote_portal_dns_answer(uint8_t *p, size_t len, size_t capacity, uint32_t ip)
{
    /* 仅处理一个未压缩的标准问题；不解析附加记录，不转发到上游。 */
    if (len < 17 || len > capacity || (p[2] & 0xF8) || p[4] || p[5] != 1) return 0;
    size_t pos = 12;
    while (pos < len && p[pos]) {
        unsigned label = p[pos++];
        if (label > 63 || label > len - pos) return 0;
        pos += label;
    }
    if (pos - 12 > 254 || pos + 5 > len) return 0;
    pos++;
    unsigned type = (p[pos] << 8) | p[pos + 1];
    if (p[pos + 2] || p[pos + 3] != 1) return 0;
    pos += 4;
    p[2] = 0x84 | (p[2] & 1);
    p[3] = 0;
    memset(p + 6, 0, 6);
    if (type != 1) return pos;
    static const uint8_t header[] = {0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4};
    if (pos + sizeof(header) + 4 > capacity) return 0;
    p[7] = 1;
    memcpy(p + pos, header, sizeof(header));
    memcpy(p + pos + sizeof(header), &ip, 4);
    return pos + sizeof(header) + 4;
}

int vote_portal_open(uint32_t ip)
{
    int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd < 0) return -1;
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(53), .sin_addr.s_addr = ip};
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) || fcntl(fd, F_SETFL, O_NONBLOCK) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

void vote_portal_tick(int fd, uint32_t ip, uint32_t mask)
{
    if (fd < 0) return;
    for (int i = 0; i < 4; i++) {
        uint8_t buf[528];
        struct sockaddr_in from;
        socklen_t addrlen = sizeof(from);
        ssize_t n = recvfrom(fd, buf, sizeof(buf), 0, (struct sockaddr *)&from, &addrlen);
        if (n < 0) break;
        if (((from.sin_addr.s_addr ^ ip) & mask) || n > 512) continue;
        size_t size = vote_portal_dns_answer(buf, (size_t)n, sizeof(buf), ip);
        if (size) sendto(fd, buf, size, 0, (struct sockaddr *)&from, addrlen);
    }
}
