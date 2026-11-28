#include "vote_model.h"
#include "vote_font_ranges.h"
#include <string.h>

void vote_model_init(vote_model_t *model)
{
    memset(model, 0, sizeof(*model));
    model->poll.my_choice = -1;
    model->pending_choice = -1;
}

void vote_model_apply(vote_model_t *model, const vote_snapshot_t *snapshot)
{
    if (strcmp(model->poll.id, snapshot->id) != 0) {
        model->selected = 0;
        model->pending_choice = -1;
        model->confirming = false;
    }
    model->poll = *snapshot;
    model->connected = true;
    if (snapshot->my_choice >= 0 || snapshot->phase != VOTE_OPEN) {
        model->pending_choice = -1;
        model->confirming = false;
    }
    if (model->selected >= snapshot->option_count) model->selected = 0;
}

void vote_model_restore_pending(vote_model_t *model, const vote_pending_t *pending)
{
    if (model->poll.phase == VOTE_OPEN && model->poll.my_choice < 0 &&
        pending->choice >= 0 && pending->choice < model->poll.option_count &&
        memcmp(model->poll.id, pending->poll_id, sizeof(pending->poll_id)) == 0) {
        model->pending_choice = pending->choice;
        model->selected = pending->choice;
        model->confirming = false;
    }
}

bool vote_model_key(vote_model_t *model, vote_key_t key)
{
    if (model->poll.phase == VOTE_PUBLISHED && key != VOTE_OK) {
        int n = model->poll.option_count;
        if (n) model->selected = (model->selected + (key == VOTE_UP ? n - 1 : 1)) % n;
        return false;
    }
    if (!model->connected || model->poll.phase != VOTE_OPEN ||
        model->poll.my_choice >= 0 || model->pending_choice >= 0) return false;
    if (key == VOTE_OK) {
        if (!model->confirming) {
            model->confirming = true;
            return false;
        }
        model->confirming = false;
        model->pending_choice = model->selected;
        return true;
    }
    if (model->confirming) {
        model->confirming = false;
    } else if (model->poll.option_count > 0) {
        int n = model->poll.option_count;
        model->selected = (model->selected + (key == VOTE_UP ? n - 1 : 1)) % n;
    }
    return false;
}

bool vote_codepoint_supported(uint32_t cp)
{
    size_t low = 0, high = sizeof(VOTE_FONT_RANGES) / sizeof(VOTE_FONT_RANGES[0]);
    while (low < high) {
        size_t middle = low + (high - low) / 2;
        if (cp < VOTE_FONT_RANGES[middle][0]) high = middle;
        else if (cp > VOTE_FONT_RANGES[middle][1]) low = middle + 1;
        else return true;
    }
    return false;
}

static bool valid_utf8(const char *text, size_t max_chars, bool screen)
{
    if (!text || !*text) return false;
    const unsigned char *s = (const unsigned char *)text;
    size_t count = 0;
    while (*s) {
        uint32_t cp = *s++;
        unsigned extra = 0;
        uint32_t minimum = 0;
        if (cp >= 0xC2 && cp <= 0xDF) { cp &= 0x1F; extra = 1; minimum = 0x80; }
        else if (cp >= 0xE0 && cp <= 0xEF) { cp &= 0x0F; extra = 2; minimum = 0x800; }
        else if (cp >= 0xF0 && cp <= 0xF4) { cp &= 0x07; extra = 3; minimum = 0x10000; }
        else if (cp >= 0x80) return false;
        while (extra--) {
            if ((*s & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (*s++ & 0x3F);
        }
        if (cp < minimum || cp < 32 || (cp >= 0x7f && cp <= 0x9f) || cp > 0x10ffff ||
            (cp >= 0xd800 && cp <= 0xdfff) || (screen && !vote_codepoint_supported(cp)) ||
            ++count > max_chars) return false;
    }
    return true;
}

bool vote_text_valid(const char *text, size_t max_chars)
{
    return valid_utf8(text, max_chars, true);
}

bool vote_ssid_displayable(const char *ssid)
{
    return ssid && strlen(ssid) <= 32 && valid_utf8(ssid, 32, false);
}

int vote_rx_push(vote_rx_t *rx, unsigned opcode, bool fin, size_t payload,
                 size_t offset, const char *data, size_t length)
{
    if (opcode >= 8) return 0; /* 控制帧可插入分片文本中，不破坏组装。 */
    if (opcode != 0 && opcode != 1) goto invalid;
    if (offset == 0) {
        if (opcode == 1) {
            rx->used = 0;
            rx->active = true;
        }
        rx->frame_used = 0;
    }
    if (!rx->active || offset != rx->frame_used || offset > payload ||
        length > payload - offset || length >= sizeof(rx->text) - rx->used) goto invalid;
    if (length && (!data || memchr(data, 0, length))) goto invalid;
    if (length) memcpy(rx->text + rx->used, data, length);
    rx->used += length;
    rx->frame_used += length;
    if (offset + length == payload && fin) {
        rx->text[rx->used] = 0;
        rx->active = false;
        return 1;
    }
    return 0;
invalid:
    memset(rx, 0, sizeof(*rx));
    return -1;
}

static void switch_set_hint(vote_switch_t *sw, const char *hint)
{
    if (!hint || !hint[0]) {
        sw->hint[0] = 0;
        return;
    }
    size_t n = strlen(hint);
    if (n >= sizeof(sw->hint)) n = sizeof(sw->hint) - 1;
    memcpy(sw->hint, hint, n);
    sw->hint[n] = 0;
}

void vote_switch_open_menu(vote_switch_t *sw)
{
    memset(sw, 0, sizeof(*sw));
    sw->mode = VOTE_SWITCH_MENU;
    memcpy(sw->code, "0000", 5);
}

void vote_switch_open_code(vote_switch_t *sw, const char *hint)
{
    if (strlen(sw->code) != 4 || strspn(sw->code, "0123456789") != 4) {
        memset(sw->code, 0, sizeof(sw->code));
        memcpy(sw->code, "0000", 5);
    }
    sw->mode = VOTE_SWITCH_CODE;
    sw->open_join = false;
    sw->cursor = 0;
    sw->failed = hint && hint[0] != 0;
    switch_set_hint(sw, hint);
}

void vote_switch_close(vote_switch_t *sw)
{
    memset(sw, 0, sizeof(*sw));
}

vote_switch_action_t vote_switch_key(vote_switch_t *sw, vote_key_t key, bool double_click)
{
    if (sw->mode == VOTE_SWITCH_MENU) {
        if (key == VOTE_UP) sw->menu_index = (sw->menu_index + 2) % 3;
        else if (key == VOTE_DOWN) sw->menu_index = (sw->menu_index + 1) % 3;
        else {
            if (sw->menu_index == 0) {
                sw->open_join = true;
                sw->mode = VOTE_SWITCH_SCAN;
                sw->failed = false;
                sw->host_count = 0;
                switch_set_hint(sw, "正在搜索开放入场的主持台");
                return VOTE_SW_ACT_SCAN_OPEN;
            }
            if (sw->menu_index == 1) {
                vote_switch_open_code(sw, "");
                return VOTE_SW_ACT_NONE;
            }
            return VOTE_SW_ACT_ENTER_SETUP;
        }
        return VOTE_SW_ACT_NONE;
    }
    if (sw->mode == VOTE_SWITCH_CODE) {
        if (double_click && key == VOTE_OK) {
            if (sw->cursor > 0) {
                sw->cursor--;
                sw->failed = false;
                sw->hint[0] = 0;
            } else {
                sw->mode = VOTE_SWITCH_MENU;
                sw->failed = false;
                sw->hint[0] = 0;
            }
            return VOTE_SW_ACT_NONE;
        }
        if (key == VOTE_UP) {
            sw->code[sw->cursor] = (char)('0' + (sw->code[sw->cursor] - '0' + 1) % 10);
            sw->failed = false;
            sw->hint[0] = 0;
            return VOTE_SW_ACT_NONE;
        }
        if (key == VOTE_DOWN) {
            sw->code[sw->cursor] = (char)('0' + (sw->code[sw->cursor] - '0' + 9) % 10);
            sw->failed = false;
            sw->hint[0] = 0;
            return VOTE_SW_ACT_NONE;
        }
        if (sw->cursor < 3) {
            sw->cursor++;
            sw->failed = false;
            sw->hint[0] = 0;
            return VOTE_SW_ACT_NONE;
        }
        sw->open_join = false;
        sw->mode = VOTE_SWITCH_SCAN;
        sw->failed = false;
        sw->host_count = 0;
        switch_set_hint(sw, "正在寻找主持台");
        return VOTE_SW_ACT_SCAN_CODE;
    }
    if (sw->mode == VOTE_SWITCH_SCAN) {
        if (!sw->failed) return VOTE_SW_ACT_NONE;
        if (key == VOTE_OK) {
            sw->failed = false;
            sw->host_count = 0;
            switch_set_hint(sw, sw->open_join ? "正在搜索开放入场的主持台" : "正在寻找主持台");
            return sw->open_join ? VOTE_SW_ACT_SCAN_OPEN : VOTE_SW_ACT_SCAN_CODE;
        }
        if (key == VOTE_DOWN && sw->open_join) {
            vote_switch_open_code(sw, "");
            return VOTE_SW_ACT_NONE;
        }
        sw->mode = VOTE_SWITCH_MENU;
        sw->failed = false;
        sw->hint[0] = 0;
        return VOTE_SW_ACT_NONE;
    }
    if (sw->mode == VOTE_SWITCH_PICK) {
        if (sw->host_count <= 0) {
            sw->mode = VOTE_SWITCH_MENU;
            return VOTE_SW_ACT_NONE;
        }
        if (key == VOTE_UP) sw->host_index = (sw->host_index + sw->host_count - 1) % sw->host_count;
        else if (key == VOTE_DOWN) sw->host_index = (sw->host_index + 1) % sw->host_count;
        else {
            sw->mode = VOTE_SWITCH_JOINING;
            sw->failed = false;
            switch_set_hint(sw, sw->open_join ? "正在一键入场" : "正在核对入场码");
            return VOTE_SW_ACT_JOIN_HOST;
        }
        return VOTE_SW_ACT_NONE;
    }
    if (sw->mode == VOTE_SWITCH_JOINING) {
        if (!sw->failed) return VOTE_SW_ACT_NONE;
        if (key == VOTE_OK) {
            if (sw->open_join) {
                sw->mode = VOTE_SWITCH_SCAN;
                sw->failed = false;
                sw->host_count = 0;
                switch_set_hint(sw, "正在搜索开放入场的主持台");
                return VOTE_SW_ACT_SCAN_OPEN;
            }
            vote_switch_open_code(sw, "");
            return VOTE_SW_ACT_NONE;
        }
        if (key == VOTE_DOWN && sw->open_join) {
            vote_switch_open_code(sw, "");
            return VOTE_SW_ACT_NONE;
        }
        sw->mode = VOTE_SWITCH_MENU;
        sw->failed = false;
        sw->hint[0] = 0;
        return VOTE_SW_ACT_NONE;
    }
    return VOTE_SW_ACT_NONE;
}

bool vote_switch_apply_hosts(vote_switch_t *sw, const vote_switch_host_t *found, int count)
{
    if (count < 0) count = 0;
    if (count > VOTE_SWITCH_HOST_LIMIT) count = VOTE_SWITCH_HOST_LIMIT;
    sw->host_count = 0;
    sw->host_index = 0;
    if (sw->open_join) {
        for (int i = 0; i < count; i++) {
            if (found[i].open_join && sw->host_count < VOTE_SWITCH_HOST_LIMIT) {
                sw->hosts[sw->host_count++] = found[i];
            }
        }
        if (!sw->host_count) {
            sw->mode = VOTE_SWITCH_SCAN;
            sw->failed = true;
            switch_set_hint(sw, count > 0 ? "暂无开放一键入场的主持台" : "未找到主持台，请重试");
            return false;
        }
        sw->mode = VOTE_SWITCH_PICK;
        sw->failed = false;
        switch_set_hint(sw, "");
        return false;
    }
    for (int i = 0; i < count; i++) sw->hosts[sw->host_count++] = found[i];
    if (!sw->host_count) {
        sw->mode = VOTE_SWITCH_SCAN;
        sw->failed = true;
        switch_set_hint(sw, "未找到主持台，请重试");
        return false;
    }
    if (sw->host_count == 1) {
        sw->mode = VOTE_SWITCH_JOINING;
        sw->failed = false;
        switch_set_hint(sw, "正在核对入场码");
        return true;
    }
    sw->mode = VOTE_SWITCH_PICK;
    sw->failed = false;
    switch_set_hint(sw, "");
    return false;
}
