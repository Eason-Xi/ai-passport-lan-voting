#pragma once
#include "vote_model.h"
#include "cJSON.h"
/* 所有网络入口共用长度、深度和字符串边界检查。调用者负责释放返回对象。 */
cJSON *vote_parse_json_object(const char *json, size_t max_bytes);
/* 无效消息不修改输出。剩余毫秒为 -1 表示该题没有进行中的倒计时。 */
bool vote_snapshot_from_json(const cJSON *root, vote_snapshot_t *snapshot, int64_t *remaining_ms);
/* 从一键入场首次响应中校验并提取 6 位数字入场码。 */
bool vote_extract_join_code(const cJSON *root, char out[7]);
