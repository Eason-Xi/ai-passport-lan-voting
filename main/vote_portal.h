#pragma once
#include <stddef.h>
#include <stdint.h>

/* 只在配网热点的 IP 上提供手机联网探测所需的 DNS 响应。 */
int vote_portal_open(uint32_t ap_ip);
void vote_portal_tick(int fd, uint32_t ap_ip, uint32_t mask);
size_t vote_portal_dns_answer(uint8_t *packet, size_t len, size_t capacity, uint32_t ap_ip);
