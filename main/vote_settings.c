#include "vote_settings.h"
#include <string.h>

static bool decimal_field(const char **cursor, unsigned maximum, char separator, unsigned *value)
{
    const char *p = *cursor;
    if (*p < '0' || *p > '9' || (*p == '0' && p[1] != separator)) return false;
    unsigned number = 0;
    do {
        number = number * 10 + (unsigned)(*p++ - '0');
        if (number > maximum) return false;
    } while (*p >= '0' && *p <= '9');
    if (*p != separator) return false;
    *cursor = p + 1;
    *value = number;
    return true;
}

static bool valid_wss_domain_uri(const char *cursor)
{
    // 校验 wss://<合法域名>[:端口]/ws，支持 Cloudflare *.workers.dev 及任意公网 TLS 域名。
    const char *host_start = cursor;
    int labels = 0;
    size_t label_len = 0;
    bool last_label_has_alpha = false;
    bool cur_label_has_alpha = false;
    while (*cursor && *cursor != ':' && *cursor != '/') {
        char c = *cursor;
        if (c == '.') {
            if (label_len == 0 || *(cursor - 1) == '-') return false;
            labels++;
            last_label_has_alpha = cur_label_has_alpha;
            label_len = 0;
            cur_label_has_alpha = false;
        } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                   (c >= '0' && c <= '9') || c == '-') {
            if (label_len == 0 && c == '-') return false;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) cur_label_has_alpha = true;
            if (++label_len > 63) return false;
        } else {
            return false;
        }
        cursor++;
    }
    if (label_len == 0 || *(cursor - 1) == '-') return false;
    labels++;
    last_label_has_alpha = cur_label_has_alpha;
    size_t host_len = (size_t)(cursor - host_start);
    // 至少包含两个标签（拒绝 localhost），且顶级域不能为纯数字（拒绝裸 IPv4）。
    if (labels < 2 || host_len > 80 || !last_label_has_alpha) return false;
    if (*cursor == ':') {
        cursor++;
        unsigned port = 0;
        if (!decimal_field(&cursor, 65535, '/', &port) || !port) return false;
    } else if (*cursor == '/') {
        cursor++;
    } else {
        return false;
    }
    return strcmp(cursor, "ws") == 0;
}

bool vote_settings_valid(const vote_settings_t *s)
{
    if (!s || s->version != 1 || !memchr(s->ssid, 0, sizeof(s->ssid)) ||
        !memchr(s->password, 0, sizeof(s->password)) || !memchr(s->server, 0, sizeof(s->server)) ||
        !memchr(s->code, 0, sizeof(s->code)) || !s->ssid[0]) return false;
    size_t password_length = strlen(s->password);
    if (password_length && (password_length < 8 || password_length > 63)) return false;
    if (strlen(s->code) != 6 || strspn(s->code, "0123456789") != 6) return false;
    // 首次空地址触发局域网自动发现，入场后保存公开会场标识；同时兼容固定局域网 IPv4 和云端 WSS 域名。
    if (!s->server[0]) return true;
    if (!strncmp(s->server, "auto:", 5))
        return strlen(s->server + 5) == 16 && strspn(s->server + 5, "0123456789abcdef") == 16;
    if (!strncmp(s->server, "wss://", 6))
        return valid_wss_domain_uri(s->server + 6);
    if (strncmp(s->server, "ws://", 5) != 0) return false;
    const char *cursor = s->server + 5;
    unsigned a, b, ignored, port;
    if (!decimal_field(&cursor, 255, '.', &a) || !decimal_field(&cursor, 255, '.', &b) ||
        !decimal_field(&cursor, 255, '.', &ignored) || !decimal_field(&cursor, 255, ':', &ignored) ||
        !decimal_field(&cursor, 65535, '/', &port) || !port || strcmp(cursor, "ws")) return false;
    /* 明文 ws:// 只接受局域网私有 IPv4，公网必须使用 wss://。 */
    return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) ||
           (a == 169 && b == 254);
}
