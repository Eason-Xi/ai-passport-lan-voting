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

bool vote_settings_valid(const vote_settings_t *s)
{
    if (!s || s->version != 1 || !memchr(s->ssid, 0, sizeof(s->ssid)) ||
        !memchr(s->password, 0, sizeof(s->password)) || !memchr(s->server, 0, sizeof(s->server)) ||
        !memchr(s->code, 0, sizeof(s->code)) || !s->ssid[0]) return false;
    size_t password_length = strlen(s->password);
    if (password_length && (password_length < 8 || password_length > 63)) return false;
    if (strlen(s->code) != 4 || strspn(s->code, "0123456789") != 4) return false;
    // 首次空地址触发自动发现，入场后保存公开会场标识，继续兼容旧版固定地址。
    if (!s->server[0]) return true;
    if (!strncmp(s->server, "auto:", 5))
        return strlen(s->server + 5) == 16 && strspn(s->server + 5, "0123456789abcdef") == 16;
    if (strncmp(s->server, "ws://", 5) != 0) return false;
    const char *cursor = s->server + 5;
    unsigned a, b, ignored, port;
    if (!decimal_field(&cursor, 255, '.', &a) || !decimal_field(&cursor, 255, '.', &b) ||
        !decimal_field(&cursor, 255, '.', &ignored) || !decimal_field(&cursor, 255, ':', &ignored) ||
        !decimal_field(&cursor, 65535, '/', &port) || !port || strcmp(cursor, "ws")) return false;
    /* 只接受局域网 IPv4，避免误填公网和本机回环地址。 */
    return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) ||
           (a == 169 && b == 254);
}
