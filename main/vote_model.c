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
