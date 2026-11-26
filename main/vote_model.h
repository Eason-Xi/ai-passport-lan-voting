#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VOTE_MAX_OPTIONS 6
#define VOTE_TITLE_BYTES 241
#define VOTE_OPTION_BYTES 97
#define VOTE_MESSAGE_BYTES 2048

typedef enum { VOTE_IDLE, VOTE_OPEN, VOTE_CLOSED, VOTE_PUBLISHED } vote_phase_t;
typedef struct {
    char id[17];
    char title[VOTE_TITLE_BYTES];
    char options[VOTE_MAX_OPTIONS][VOTE_OPTION_BYTES];
    int option_count;
    vote_phase_t phase;
    int my_choice;
    int counts[VOTE_MAX_OPTIONS];
    int total;
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
