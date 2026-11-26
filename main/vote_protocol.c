#include "vote_protocol.h"
#include "cJSON.h"
#include <string.h>

static bool integer(const cJSON *value, int minimum, int maximum)
{
    return cJSON_IsNumber(value) && value->valuedouble >= minimum &&
           value->valuedouble <= maximum && value->valuedouble == value->valueint;
}

static bool text_field(const cJSON *object, const char *key, char *dest, size_t capacity, size_t chars)
{
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
    if (!cJSON_IsString(value) || strlen(value->valuestring) >= capacity ||
        !vote_text_valid(value->valuestring, chars)) return false;
    strcpy(dest, value->valuestring);
    return true;
}

cJSON *vote_parse_json_object(const char *json, size_t max_bytes)
{
    if (!json || strlen(json) > max_bytes) return NULL;
    // 先限制嵌套深度，避免错误输入耗尽无 PSRAM 芯片的任务栈。
    int depth = 0;
    bool quoted = false, escaped = false;
    for (const char *p = json; *p; p++) {
        if (quoted) {
            if (escaped) {
                if (strncmp(p, "u0000", 5) == 0) return NULL;
                escaped = false;
            }
            else if (*p == '\\') escaped = true;
            else if (*p == '"') quoted = false;
        } else if (*p == '"') quoted = true;
        else if (*p == '{' || *p == '[') { if (++depth > 8) return NULL; }
        else if (*p == '}' || *p == ']') { if (--depth < 0) return NULL; }
    }
    if (depth || quoted) return NULL;
    cJSON *root = cJSON_ParseWithOpts(json, NULL, true);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return NULL;
    }
    return root;
}

bool vote_snapshot_from_json(const cJSON *root, vote_snapshot_t *snapshot, int64_t *remaining_ms)
{
    bool valid = false;
    vote_snapshot_t next = {.my_choice = -1};
    int64_t remaining = -1;
    if (!root || !snapshot || !remaining_ms) return false;
    const cJSON *version = cJSON_GetObjectItemCaseSensitive(root, "v");
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    if (!integer(version, 1, 1) || !cJSON_IsString(type) || strcmp(type->valuestring, "state")) goto done;
    const cJSON *poll = cJSON_GetObjectItemCaseSensitive(root, "poll");
    if (cJSON_IsNull(poll)) { valid = true; goto done; }
    if (!cJSON_IsObject(poll) || !text_field(poll, "id", next.id, sizeof(next.id), 16) ||
        strlen(next.id) != 16 || strspn(next.id, "0123456789abcdef") != 16 ||
        !text_field(poll, "title", next.title, sizeof(next.title), 60)) goto done;
    const cJSON *phase = cJSON_GetObjectItemCaseSensitive(poll, "phase");
    if (!cJSON_IsString(phase)) goto done;
    if (!strcmp(phase->valuestring, "open")) next.phase = VOTE_OPEN;
    else if (!strcmp(phase->valuestring, "closed")) next.phase = VOTE_CLOSED;
    else if (!strcmp(phase->valuestring, "published")) next.phase = VOTE_PUBLISHED;
    else goto done;
    const cJSON *left = cJSON_GetObjectItemCaseSensitive(poll, "remaining_ms");
    if (left) {
        // 毫秒值可能超过 32 位。先检查范围再转整型，兼容旧主持台省略此字段。
        if (next.phase != VOTE_OPEN || !cJSON_IsNumber(left) ||
            !(left->valuedouble >= 0 && left->valuedouble <= 253402300799999.0)) goto done;
        remaining = (int64_t)left->valuedouble;
        if ((double)remaining != left->valuedouble) goto done;
    }
    const cJSON *options = cJSON_GetObjectItemCaseSensitive(poll, "options");
    if (!cJSON_IsArray(options)) goto done;
    next.option_count = cJSON_GetArraySize(options);
    if (next.option_count < 2 || next.option_count > VOTE_MAX_OPTIONS) goto done;
    for (int i = 0; i < next.option_count; i++) {
        const cJSON *item = cJSON_GetArrayItem(options, i);
        if (!cJSON_IsString(item) || strlen(item->valuestring) >= VOTE_OPTION_BYTES ||
            !vote_text_valid(item->valuestring, 24)) goto done;
        strcpy(next.options[i], item->valuestring);
    }
    const cJSON *choice = cJSON_GetObjectItemCaseSensitive(poll, "my_choice");
    if (!integer(choice, -1, next.option_count - 1)) goto done;
    next.my_choice = choice->valueint;
    if (next.phase == VOTE_PUBLISHED) {
        const cJSON *counts = cJSON_GetObjectItemCaseSensitive(poll, "counts");
        const cJSON *total = cJSON_GetObjectItemCaseSensitive(poll, "total");
        if (!cJSON_IsArray(counts) || cJSON_GetArraySize(counts) != next.option_count || !integer(total, 0, 10000)) goto done;
        for (int i = 0; i < next.option_count; i++) {
            const cJSON *item = cJSON_GetArrayItem(counts, i);
            if (!integer(item, 0, 10000)) goto done;
            next.counts[i] = item->valueint;
            next.total += item->valueint;
        }
        if (next.total != total->valueint || (next.my_choice >= 0 && next.counts[next.my_choice] == 0)) goto done;
    }
    valid = true;
done:
    if (valid) {
        *snapshot = next;
        *remaining_ms = remaining;
    }
    return valid;
}
