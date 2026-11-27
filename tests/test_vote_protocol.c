#include "vote_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static int64_t remaining;
static bool vote_parse_snapshot(const char *text, vote_snapshot_t *snapshot)
{
    cJSON *root = vote_parse_json_object(text, VOTE_MESSAGE_BYTES - 1);
    bool valid = vote_snapshot_from_json(root, snapshot, &remaining);
    cJSON_Delete(root);
    return valid;
}

int main(int argc, char **argv)
{
    vote_snapshot_t snapshot = {0};
    const char *open = "{\"v\":1,\"type\":\"state\",\"poll\":{\"id\":\"0123456789abcdef\",\"phase\":\"open\",\"title\":\"选择\",\"options\":[\"中文\",\"English\"],\"my_choice\":-1}}";
    assert(vote_parse_snapshot(open, &snapshot));
    assert(snapshot.phase == VOTE_OPEN && snapshot.option_count == 2 && !strcmp(snapshot.title, "选择"));
    assert(remaining == -1);
    const char *timed = "{\"v\":1,\"type\":\"state\",\"poll\":{\"id\":\"0123456789abcdef\",\"phase\":\"open\",\"title\":\"选择\",\"options\":[\"a\",\"b\"],\"my_choice\":-1,\"remaining_ms\":%s}}";
    char packet[512];
    snprintf(packet, sizeof(packet), timed, "3000000001");
    assert(vote_parse_snapshot(packet, &snapshot) && remaining == INT64_C(3000000001));
    const char *bad_ms[] = {"-1", "0.5", "true", "null", "\"30\"", "253402300800000", "1e999"};
    for (size_t i = 0; i < sizeof(bad_ms)/sizeof(bad_ms[0]); i++) {
        snprintf(packet, sizeof(packet), timed, bad_ms[i]);
        assert(!vote_parse_snapshot(packet, &snapshot) && remaining == INT64_C(3000000001));
    }
    snprintf(packet, sizeof(packet), timed, "0");
    assert(vote_parse_snapshot(packet, &snapshot) && remaining == 0);
    const char *group = "{\"v\":1,\"type\":\"state\",\"poll\":{\"id\":\"0123456789abcdef\",\"phase\":\"open\",\"title\":\"甲\",\"options\":[\"甲\",\"乙\"],\"my_choice\":-1,\"batch\":%s}}";
    snprintf(packet, sizeof(packet), group, "{\"count\":50,\"index\":49,\"answered\":48}");
    assert(vote_parse_snapshot(packet, &snapshot) && snapshot.batch_index == 49 &&
           snapshot.batch_count == 50 && snapshot.answered == 48 && !snapshot.next_id[0]);
    const char *bad_groups[] = {"null", "[]", "{\"count\":51,\"index\":1,\"answered\":0}",
        "{\"count\":2,\"index\":0,\"answered\":0}", "{\"count\":2,\"index\":3,\"answered\":0}",
        "{\"count\":2,\"index\":1,\"answered\":3}", "{\"count\":2,\"index\":1,\"answered\":0.5}"};
    for (size_t i = 0; i < sizeof(bad_groups)/sizeof(bad_groups[0]); i++) {
        snprintf(packet, sizeof(packet), group, bad_groups[i]);
        assert(!vote_parse_snapshot(packet, &snapshot));
    }
    vote_snapshot_t before = snapshot;
    const char *invalid[] = {
        "[]", "{}", "[[[[[[[[[0]]]]]]]]]", "{\"v\":2,\"type\":\"state\",\"poll\":null}",
        "{\"v\":1,\"type\":\"state\\u0000ignored\",\"poll\":null}",
        "{\"v\":1,\"type\":\"state\",\"poll\":{}}",
        "{\"v\":1,\"type\":\"state\",\"poll\":null} garbage",
        "{\"v\":1,\"type\":\"state\",\"poll\":{\"id\":\"0123456789abcdef\",\"phase\":\"open\",\"title\":\"😀\",\"options\":[\"a\",\"b\"],\"my_choice\":-1}}",
        "{\"v\":1,\"type\":\"state\",\"poll\":{\"id\":\"0123456789abcdef\",\"phase\":\"published\",\"title\":\"问题\",\"options\":[\"a\",\"b\"],\"my_choice\":-1,\"counts\":[1,2],\"total\":2}}",
        "{\"v\":1,\"type\":\"state\",\"poll\":{\"id\":\"0123456789abcdef\",\"phase\":\"open\",\"title\":\"问题\",\"options\":[\"a\",\"b\"],\"my_choice\":0.5}}"
    };
    for (size_t i = 0; i < sizeof(invalid)/sizeof(invalid[0]); i++) {
        assert(!vote_parse_snapshot(invalid[i], &snapshot));
        assert(!memcmp(&before, &snapshot, sizeof(snapshot)));
    }
    assert(vote_parse_snapshot("{\"v\":1,\"type\":\"state\",\"poll\":null}", &snapshot));
    assert(snapshot.phase == VOTE_IDLE && snapshot.my_choice == -1 && remaining == -1);
    cJSON *literal = vote_parse_json_object("{\"text\":\"\\\\u0000\"}", 128);
    assert(literal && !strcmp(cJSON_GetObjectItem(literal, "text")->valuestring, "\\u0000"));
    cJSON_Delete(literal);
    char extracted[7] = {0};
    cJSON *with_code = vote_parse_json_object("{\"v\":1,\"type\":\"state\",\"poll\":null,\"join_code\":\"042918\"}", 128);
    assert(with_code && vote_extract_join_code(with_code, extracted) && !strcmp(extracted, "042918"));
    cJSON_Delete(with_code);
    const char *bad_codes[] = {
        "{\"v\":1,\"type\":\"state\",\"poll\":null}",
        "{\"join_code\":\"12345\"}",
        "{\"join_code\":\"1234567\"}",
        "{\"join_code\":\"12345a\"}",
        "{\"join_code\":123456}"
    };
    for (size_t i = 0; i < sizeof(bad_codes)/sizeof(bad_codes[0]); i++) {
        cJSON *obj = vote_parse_json_object(bad_codes[i], 128);
        assert(obj && !vote_extract_join_code(obj, extracted));
        cJSON_Delete(obj);
    }
    // 可把真实服务产生的 JSONL 快照交给固件同一解析器检查协议兼容性。
    if (argc > 1) {
        FILE *file = fopen(argv[1], "r"); assert(file);
        char line[VOTE_MESSAGE_BYTES]; int count = 0;
        while (fgets(line, sizeof(line), file)) { assert(vote_parse_snapshot(line, &snapshot)); count++; }
        fclose(file); assert(count > 0);
        printf("真实服务快照解析：%d 条通过\n", count);
    }
    puts("固件 JSON 协议校验：通过");
    return 0;
}
