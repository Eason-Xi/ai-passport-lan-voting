#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VOTE_MAX_OPTIONS 10
#define VOTE_MAX_BATCH 50
#define VOTE_TITLE_BYTES 241
#define VOTE_OPTION_BYTES 97
#define VOTE_MESSAGE_BYTES 2560
#define VOTE_SWITCH_HOST_LIMIT 8

typedef enum { VOTE_IDLE, VOTE_OPEN, VOTE_CLOSED, VOTE_PUBLISHED } vote_phase_t;
typedef enum {
    VOTE_SWITCH_NONE,
    VOTE_SWITCH_MENU,
    VOTE_SWITCH_CODE,
    VOTE_SWITCH_SCAN,
    VOTE_SWITCH_PICK,
    VOTE_SWITCH_JOINING
} vote_switch_mode_t;
typedef enum {
    VOTE_SW_ACT_NONE,
    VOTE_SW_ACT_CLOSE,
    VOTE_SW_ACT_SCAN_OPEN,
    VOTE_SW_ACT_SCAN_CODE,
    VOTE_SW_ACT_JOIN_HOST,
    VOTE_SW_ACT_ENTER_SETUP
} vote_switch_action_t;
typedef struct {
    char id[17];
    bool open_join;
} vote_switch_host_t;
typedef struct {
    vote_switch_mode_t mode;
    int menu_index;
    bool open_join;
    char code[7];
    int cursor;
    vote_switch_host_t hosts[VOTE_SWITCH_HOST_LIMIT];
    int host_count;
    int host_index;
    bool failed;
    char hint[96];
} vote_switch_t;
typedef struct {
    char id[17];
    char title[VOTE_TITLE_BYTES];
    char options[VOTE_MAX_OPTIONS][VOTE_OPTION_BYTES];
    int option_count;
    vote_phase_t phase;
    int my_choice;
    int counts[VOTE_MAX_OPTIONS];
    int total;
    int batch_index, batch_count, answered;
    char next_id[17], prev_id[17];
} vote_snapshot_t;
typedef struct {
    vote_snapshot_t poll;
    int selected;
    int pending_choice;
    bool confirming;
    bool connected;
} vote_model_t;
typedef struct {
    char poll_id[17];
    int32_t choice;
} vote_pending_t;
typedef enum { VOTE_UP, VOTE_DOWN, VOTE_OK } vote_key_t;
typedef struct {
    char text[VOTE_MESSAGE_BYTES];
    size_t used;
    size_t frame_used;
    bool active;
} vote_rx_t;

void vote_model_init(vote_model_t *model);
void vote_model_apply(vote_model_t *model, const vote_snapshot_t *snapshot);
void vote_model_restore_pending(vote_model_t *model, const vote_pending_t *pending);
bool vote_model_key(vote_model_t *model, vote_key_t key);
bool vote_text_valid(const char *text, size_t max_chars);
bool vote_ssid_displayable(const char *ssid);
bool vote_codepoint_supported(uint32_t cp);
/* 返回 1 表示消息完成，0 表示等待，-1 表示丢弃无效或过长帧。 */
int vote_rx_push(vote_rx_t *rx, unsigned opcode, bool fin, size_t payload,
                 size_t offset, const char *data, size_t length);

void vote_switch_open_menu(vote_switch_t *sw);
void vote_switch_open_code(vote_switch_t *sw, const char *hint);
void vote_switch_close(vote_switch_t *sw);
vote_switch_action_t vote_switch_key(vote_switch_t *sw, vote_key_t key, bool double_click);
/* 应用发现到的主持台列表；返回 true 表示唯一目标已就绪、可直接连接校验。 */
bool vote_switch_apply_hosts(vote_switch_t *sw, const vote_switch_host_t *found, int count);
