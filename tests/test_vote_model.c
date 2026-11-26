#include "vote_model.h"
#include "vote_settings.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    vote_model_t model;
    vote_model_init(&model);
    vote_snapshot_t poll = {.id = "0000000000000001", .title = "选择你的答案", .phase = VOTE_OPEN, .option_count = 6, .my_choice = -1};
    vote_model_apply(&model, &poll);
    assert(!vote_model_key(&model, VOTE_UP) && model.selected == 5);
    assert(!vote_model_key(&model, VOTE_DOWN) && model.selected == 0);
    assert(!vote_model_key(&model, VOTE_OK) && model.confirming);
    assert(!vote_model_key(&model, VOTE_UP) && !model.confirming && model.selected == 0);
    assert(!vote_model_key(&model, VOTE_OK));
    assert(vote_model_key(&model, VOTE_OK) && model.pending_choice == 0);
    assert(!vote_model_key(&model, VOTE_DOWN) && model.selected == 0);
    model.connected = false;
    assert(!vote_model_key(&model, VOTE_OK));
    vote_model_apply(&model, &poll);
    assert(model.pending_choice == 0); // 确认丢失后继续幂等重试。
    poll.my_choice = 0;
    vote_model_apply(&model, &poll);
    assert(model.pending_choice == -1 && !vote_model_key(&model, VOTE_OK));
    poll.phase = VOTE_PUBLISHED;
    vote_model_apply(&model, &poll);
    vote_model_key(&model, VOTE_DOWN);
    assert(model.selected == 1);
    strcpy(poll.id, "0000000000000002");
    poll.phase = VOTE_OPEN;
    poll.my_choice = -1;
    vote_model_apply(&model, &poll);
    assert(model.selected == 0 && model.pending_choice == -1);
    vote_pending_t saved = {.poll_id = "0000000000000001", .choice = 2};
    vote_model_restore_pending(&model, &saved);
    assert(model.pending_choice == -1);
    strcpy(saved.poll_id, poll.id);
    vote_model_restore_pending(&model, &saved);
    assert(model.pending_choice == 2 && model.selected == 2 && !vote_model_key(&model, VOTE_UP));
    poll.my_choice = 2;
    vote_model_apply(&model, &poll);
    vote_model_restore_pending(&model, &saved);
    assert(model.pending_choice == -1 && model.poll.my_choice == 2);
    poll.my_choice = -1;
    vote_model_apply(&model, &poll);
    vote_model_key(&model, VOTE_OK);
    vote_model_key(&model, VOTE_OK);
    poll.phase = VOTE_CLOSED;
    vote_model_apply(&model, &poll);
    assert(model.pending_choice == -1 && !vote_model_key(&model, VOTE_OK));
    assert(vote_text_valid("中文 English，标点。", 24));
    assert(!vote_text_valid("😀", 24));
    assert(!vote_text_valid("\xED\xA0\x80", 24));
    assert(!vote_text_valid("\xC0\x80", 24));
    assert(!vote_text_valid("\xE4\xB8", 24));
    assert(!vote_text_valid("\n", 24));
    assert(!vote_text_valid("123", 2));

    vote_rx_t rx = {0};
    assert(vote_rx_push(&rx, 1, false, 4, 0, "ab", 2) == 0);
    assert(vote_rx_push(&rx, 9, true, 1, 0, "?", 1) == 0);
    assert(vote_rx_push(&rx, 1, false, 4, 2, "cd", 2) == 0);
    assert(vote_rx_push(&rx, 0, true, 2, 0, "ef", 2) == 1);
    assert(!strcmp(rx.text, "abcdef"));
    assert(vote_rx_push(&rx, 0, true, 1, 0, "x", 1) == -1);
    assert(vote_rx_push(&rx, 1, true, 4, 2, "cd", 2) == -1);
    assert(vote_rx_push(&rx, 1, true, 3, 0, "a\0b", 3) == -1);
    char huge[VOTE_MESSAGE_BYTES]; memset(huge, 'a', sizeof(huge));
    assert(vote_rx_push(&rx, 1, true, sizeof(huge), 0, huge, sizeof(huge)) == -1);
    assert(vote_rx_push(&rx, 1, true, 2, 0, "{}", 2) == 1);
    vote_settings_t settings = {.version=1, .ssid="测试网络", .password="testpass", .server="ws://192.168.1.2:8765/ws", .code="123456"};
    assert(vote_settings_valid(&settings));
    strcpy(settings.server, "ws://127.0.0.1:8765/ws"); assert(!vote_settings_valid(&settings));
    strcpy(settings.server, "ws://192.168.1.2:8765/ws/evil"); assert(!vote_settings_valid(&settings));
    strcpy(settings.server, "ws://10.0.0.2:8765/ws"); assert(vote_settings_valid(&settings));
    settings.server[0] = 0; assert(vote_settings_valid(&settings));
    strcpy(settings.server, "auto:0123456789abcdef"); assert(vote_settings_valid(&settings));
    strcpy(settings.server, "auto:abcd"); assert(!vote_settings_valid(&settings));
    strcpy(settings.server, "auto:0123456789abcdeg"); assert(!vote_settings_valid(&settings));
    strcpy(settings.server, "auto:0123456789abcdef");
    assert(vote_ssid_displayable("舞台📶") && !vote_ssid_displayable("\xc0\x80"));
    assert(!vote_ssid_displayable("会议\n室") && !vote_ssid_displayable(""));
    strcpy(settings.password, "short"); assert(!vote_settings_valid(&settings));
    settings.password[0] = 0; assert(vote_settings_valid(&settings));
    memset(settings.ssid, 'a', sizeof(settings.ssid)); assert(!vote_settings_valid(&settings));
    puts("投票状态、UTF-8、分片重组和配网校验：通过");
    return 0;
}
