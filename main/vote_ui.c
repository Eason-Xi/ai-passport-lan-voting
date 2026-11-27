#include "vote_ui.h"
#include "lvgl.h"
#include <stdio.h>
#include <string.h>

LV_FONT_DECLARE(vote_zh18);
#define INK 0x193C39
#define MUTED 0x73877B
#define PAPER 0xF3F5EE
#define GREEN 0x176756
#define SOFT 0xE0EADC
static lv_anim_t s_scroll_animation;
static bool s_animation_ready;
static lv_obj_t *s_heading;

static lv_obj_t *label(lv_obj_t *parent, int x, int y, int w, const char *text, uint32_t color)
{
    lv_obj_t *object = lv_label_create(parent);
    lv_obj_set_pos(object, x, y);
    lv_obj_set_width(object, w);
    lv_obj_set_style_text_font(object, &vote_zh18, 0);
    lv_obj_set_style_text_color(object, lv_color_hex(color), 0);
    lv_obj_set_style_anim(object, &s_scroll_animation, 0);
    lv_obj_set_style_anim_duration(object, lv_anim_speed(30), 0);
    lv_label_set_text(object, text);
    return object;
}

static lv_obj_t *panel(lv_obj_t *parent, int x, int y, int w, int h, uint32_t color)
{
    lv_obj_t *object = lv_obj_create(parent);
    lv_obj_remove_style_all(object);
    lv_obj_set_pos(object, x, y);
    lv_obj_set_size(object, w, h);
    lv_obj_set_style_bg_color(object, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(object, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(object, 9, 0);
    lv_obj_remove_flag(object, LV_OBJ_FLAG_SCROLLABLE);
    return object;
}

static void line(lv_obj_t *root, int y, const char *text, uint32_t color)
{
    lv_obj_t *object = label(root, 18, y, 204, text, color);
    lv_label_set_long_mode(object, LV_LABEL_LONG_SCROLL_CIRCULAR);
}

static void footer(lv_obj_t *root, const char *text)
{
    lv_obj_t *object = label(root, 18, 284, 204, text, MUTED);
    lv_obj_set_style_text_align(object, LV_TEXT_ALIGN_CENTER, 0);
}

void vote_ui_show_remaining(int64_t seconds)
{
    char text[40];
    if (seconds < 0) {
        lv_label_set_text_static(s_heading, "共选 / 投票器");
    } else if (seconds == 0) {
        lv_label_set_text_static(s_heading, "等待截止确认");
    } else {
        unsigned hours = (unsigned)(seconds / 3600);
        unsigned minutes = (unsigned)(seconds / 60 % 60), rest = (unsigned)(seconds % 60);
        if (hours >= 24) snprintf(text, sizeof(text), "剩余 %u天", hours / 24);
        else if (hours > 0) snprintf(text, sizeof(text), "剩余 %u:%02u:%02u", hours, minutes, rest);
        else snprintf(text, sizeof(text), "剩余 %02u:%02u", minutes, rest);
        lv_label_set_text(s_heading, text);
    }
}

static void format_host_tag(char out[12], const char *host_id)
{
    size_t len = strlen(host_id);
    const char *tail = len >= 8 ? host_id + len - 8 : host_id;
    size_t i = 0;
    for (; tail[i] && i < 8; i++) {
        char c = tail[i];
        out[i] = (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : c;
    }
    out[i] = 0;
}

static void render_switch(lv_obj_t *root, const vote_switch_t *sw)
{
    char text[96];
    if (sw->mode == VOTE_SWITCH_MENU) {
        line(root, 50, "切换会场 / 配网", INK);
        static const char *const items[3] = {"一键加入会场", "输入新入场码", "重新配置网络"};
        for (int i = 0; i < 3; i++) {
            bool selected = i == sw->menu_index;
            lv_obj_t *box = panel(root, 12, 92 + i * 52, 216, 44, selected ? GREEN : SOFT);
            snprintf(text, sizeof(text), "%d  %s", i + 1, items[i]);
            label(box, 12, 11, 192, text, selected ? 0xFFFFFF : INK);
        }
        line(root, 254, "前两项免手机，不断网", MUTED);
        footer(root, "确定进入 / 长按返回");
        return;
    }
    if (sw->mode == VOTE_SWITCH_CODE) {
        line(root, 50, "输入 6 位入场码", INK);
        for (int i = 0; i < 6; i++) {
            bool active = i == sw->cursor;
            int x = 14 + i * 36;
            if (active) {
                lv_obj_t *up = label(root, x, 80, 32, "^", GREEN);
                lv_obj_set_style_text_align(up, LV_TEXT_ALIGN_CENTER, 0);
                lv_obj_t *dn = label(root, x, 152, 32, "v", GREEN);
                lv_obj_set_style_text_align(dn, LV_TEXT_ALIGN_CENTER, 0);
            }
            lv_obj_t *cell = panel(root, x, 102, 32, 46, active ? GREEN : SOFT);
            char digit[2] = {sw->code[i] ? sw->code[i] : '0', 0};
            lv_obj_t *num = label(cell, 0, 12, 32, digit, active ? 0xFFFFFF : INK);
            lv_obj_set_style_text_align(num, LV_TEXT_ALIGN_CENTER, 0);
        }
        if (sw->hint[0]) {
            label(root, 18, 184, 204, sw->hint, 0x9B632B);
            label(root, 18, 232, 204, "上下修改  确定提交", MUTED);
        } else {
            label(root, 18, 186, 204, sw->cursor < 5 ? "上下调数字  确定下一位" : "上下调数字  确定加入", GREEN);
            label(root, 18, 222, 204, "双击确定：退回上一位", MUTED);
        }
        footer(root, "长按确定：返回");
        return;
    }
    if (sw->mode == VOTE_SWITCH_SCAN) {
        line(root, 50, sw->open_join ? "一键加入会场" : "核对新入场码", INK);
        lv_obj_t *box = panel(root, 12, 92, 216, 90, SOFT);
        label(box, 12, 16, 192, sw->hint[0] ? sw->hint : "正在搜索主持台", sw->failed ? 0x9B632B : GREEN);
        if (sw->failed) {
            label(root, 18, 198, 204,
                  sw->open_join ? "确定：重新搜索\n下键：改输 6 位入场码" : "确定：重新搜索\n上键：返回菜单",
                  MUTED);
        } else if (sw->open_join) {
            label(root, 18, 200, 204, "请先在电脑主持台\n点击「一键入场」", MUTED);
        }
        footer(root, "长按确定：返回");
        return;
    }
    if (sw->mode == VOTE_SWITCH_PICK) {
        line(root, 50, sw->open_join ? "选择一键入场会场" : "选择要加入的主持台", INK);
        int first = sw->host_index < 3 ? 0 : sw->host_index - 2;
        for (int row = 0; row < 3 && first + row < sw->host_count; row++) {
            int i = first + row;
            bool selected = i == sw->host_index;
            char tag[12];
            format_host_tag(tag, sw->hosts[i].id);
            lv_obj_t *box = panel(root, 12, 94 + row * 50, 216, 42, selected ? GREEN : SOFT);
            snprintf(text, sizeof(text), "会场 %s", tag);
            label(box, 12, 10, 192, text, selected ? 0xFFFFFF : INK);
        }
        snprintf(text, sizeof(text), "%d/%d  上下选择 / 确定加入", sw->host_index + 1, sw->host_count);
        line(root, 252, text, MUTED);
        footer(root, "长按确定：返回");
        return;
    }
    line(root, 50, sw->open_join ? "一键加入会场" : "核对新入场码", INK);
    lv_obj_t *box = panel(root, 12, 92, 216, 94, SOFT);
    if (sw->host_index >= 0 && sw->host_index < sw->host_count) {
        char tag[12];
        format_host_tag(tag, sw->hosts[sw->host_index].id);
        snprintf(text, sizeof(text), "会场 %s", tag);
        label(box, 12, 12, 192, text, INK);
    }
    label(box, 12, 46, 192, sw->hint[0] ? sw->hint : "正在连接", sw->failed ? 0x9B632B : GREEN);
    if (sw->failed) {
        label(root, 18, 202, 204,
              sw->open_join ? "确定：重新搜索\n下键：改输 6 位入场码" : "确定：修改入场码\n上下：返回菜单",
              MUTED);
    }
    footer(root, "长按确定：返回");
}

void vote_ui_render(const vote_view_t *view)
{
    if (!s_animation_ready) {
        lv_anim_init(&s_scroll_animation);
        lv_anim_set_delay(&s_scroll_animation, 1500);
        lv_anim_set_repeat_delay(&s_scroll_animation, 1500);
        lv_anim_set_repeat_count(&s_scroll_animation, LV_ANIM_REPEAT_INFINITE);
        s_animation_ready = true;
    }
    lv_obj_t *root = lv_screen_active();
    lv_obj_clean(root);
    lv_obj_set_style_bg_color(root, lv_color_hex(PAPER), 0);
    lv_obj_set_style_bg_opa(root, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root, 0, 0);
    lv_obj_remove_flag(root, LV_OBJ_FLAG_SCROLLABLE);
    s_heading = label(root, 18, 15, 147, "共选 / 投票器", GREEN);
    char text[160];
    if (view->battery < 0) snprintf(text, sizeof(text), "--%%");
    else snprintf(text, sizeof(text), "%d%%", view->battery);
    lv_obj_t *battery = label(root, 170, 15, 52, text, MUTED);
    lv_obj_set_style_text_align(battery, LV_TEXT_ALIGN_RIGHT, 0);

    if (view->sw.mode != VOTE_SWITCH_NONE) {
        render_switch(root, &view->sw);
        return;
    }
    if (view->settings_prompt) {
        line(root, 64, "重新配置网络？", INK);
        label(root, 18, 114, 204, "旧配置会保留到新网络连接成功。", MUTED);
        label(root, 18, 192, 204, "确定：进入配网\n上下：返回投票", GREEN);
        footer(root, "已投记录仍保留");
        return;
    }
    if (view->setup) {
        line(root, 44, view->setup_page_qr ? "扫码打开配网页" : "扫码加入设备热点", INK);
        char payload[96];
        if (view->setup_page_qr) strcpy(payload, "http://192.168.4.1/");
        else snprintf(payload, sizeof(payload), "WIFI:T:WPA;S:%s;P:%s;;", view->ap_name, view->ap_password);
        lv_obj_t *qr = lv_qrcode_create(root);
        lv_qrcode_set_size(qr, 152);
        lv_obj_set_pos(qr, 44, 70);
        lv_qrcode_set_quiet_zone(qr, true);
        if (lv_qrcode_update(qr, payload, strlen(payload)) != LV_RESULT_OK)
            label(root, 26, 128, 188, "请使用下方信息连接", INK);
        line(root, 224, view->setup_page_qr ? "192.168.4.1" : view->ap_name, GREEN);
        snprintf(text, sizeof(text), "密码 %s", view->ap_password);
        line(root, 248, view->setup_page_qr ? view->status : text, MUTED);
        footer(root, view->setup_can_exit ? "上下换码 / 长按退出" : "上下键切换二维码");
        return;
    }
    const vote_model_t *model = &view->model;
    const vote_snapshot_t *poll = &model->poll;
    if (poll->phase == VOTE_IDLE) {
        label(root, 18, 74, 204, model->connected ? "已入场" : "正在连接", INK);
        lv_obj_t *box = panel(root, 12, 119, 216, 83, SOFT);
        label(box, 12, 15, 192, model->connected ? "等待主持人\n发起下一道题" : "请保持电脑与设备\n处于同一局域网", GREEN);
        snprintf(text, sizeof(text), "设备 %s", view->device + 6);
        line(root, 219, text, MUTED);
        line(root, 250, view->status, GREEN);
        footer(root, "长按确定：切换 / 配网");
        return;
    }
    const char *phase = poll->phase == VOTE_PUBLISHED ? "结果已公布" : poll->phase == VOTE_CLOSED ? "收票已截止" : "选择你的答案";
    bool batch = poll->batch_count > 1;
    if (batch) {
        const char *stage = poll->phase == VOTE_PUBLISHED ? "结果" : poll->phase == VOTE_CLOSED ? "已截止" : "作答";
        snprintf(text, sizeof(text), "%s %d/%d  已答 %d", stage, poll->batch_index, poll->batch_count, poll->answered);
        phase = text;
    }
    line(root, 50, model->connected ? phase : "连接中断，正在重连", model->connected ? GREEN : 0x9B632B);
    line(root, 82, poll->title, INK);
    if (poll->phase == VOTE_PUBLISHED) {
        for (int i = 0; i < poll->option_count; i++) {
            int y = 118 + i * 26;
            snprintf(text, sizeof(text), "%c %s", 'A' + i, poll->options[i]);
            lv_obj_t *option = label(root, 18, y, 109, text, i == model->selected ? GREEN : INK);
            lv_label_set_long_mode(option, i == model->selected ? LV_LABEL_LONG_SCROLL_CIRCULAR : LV_LABEL_LONG_DOT);
            int percentage = poll->total ? (poll->counts[i] * 100 + poll->total / 2) / poll->total : 0;
            snprintf(text, sizeof(text), "%d票 %d%%", poll->counts[i], percentage);
            lv_obj_t *count = label(root, 129, y, 93, text, MUTED);
            lv_obj_set_style_text_align(count, LV_TEXT_ALIGN_RIGHT, 0);
            if (poll->counts[i] > 0) panel(root, 18, y + 22, 200 * poll->counts[i] / poll->total + 1, 2, SOFT);
        }
        snprintf(text, sizeof(text), batch ? "共 %d 票 / 确定换题" : "共 %d 票 / 上下查看", poll->total);
        footer(root, text);
        return;
    }
    if (model->confirming || model->pending_choice >= 0 || poll->my_choice >= 0 || poll->phase == VOTE_CLOSED) {
        int choice = poll->my_choice >= 0 ? poll->my_choice : model->pending_choice >= 0 ? model->pending_choice : model->selected;
        const char *status = model->confirming ? "确认提交这项？" : poll->my_choice >= 0 ? "投票成功" : model->pending_choice >= 0 ? "正在确认提交" : "本题未投票";
        if (batch && poll->answered == poll->batch_count) status = "本组已全部完成";
        lv_obj_t *box = panel(root, 12, 122, 216, 99, SOFT);
        label(box, 12, 12, 192, status, GREEN);
        if (poll->my_choice >= 0 || model->pending_choice >= 0 || model->confirming) {
            snprintf(text, sizeof(text), "%c  %s", 'A' + choice, poll->options[choice]);
            lv_obj_t *option = label(box, 12, 53, 192, text, INK);
            lv_label_set_long_mode(option, LV_LABEL_LONG_SCROLL_CIRCULAR);
        }
        const char *hint = model->confirming ? "提交后不可更改" : model->pending_choice >= 0 ? "收到确认才算成功" : "等待主持人公布结果";
        if (model->confirming && view->ballot_save_failed) hint = "未保存，请再按确定";
        line(root, 240, hint, MUTED);
        footer(root, model->confirming ? "确定提交 / 上下返回" : "长按确定：切换 / 配网");
        return;
    }
    int first = model->selected < 3 ? 0 : model->selected - 2;
    for (int row = 0; row < 3 && first + row < poll->option_count; row++) {
        int i = first + row;
        bool selected = i == model->selected;
        lv_obj_t *box = panel(root, 12, 119 + row * 46, 216, 39, selected ? GREEN : SOFT);
        snprintf(text, sizeof(text), "%c  %s", 'A' + i, poll->options[i]);
        lv_obj_t *option = label(box, 10, 8, 196, text, selected ? 0xFFFFFF : INK);
        lv_label_set_long_mode(option, selected ? LV_LABEL_LONG_SCROLL_CIRCULAR : LV_LABEL_LONG_DOT);
    }
    snprintf(text, sizeof(text), "%d/%d  上下选择 / 确定", model->selected + 1, poll->option_count);
    if (batch) line(root, 258, poll->batch_index < poll->batch_count ? "提交后自动进入下一题" : "提交后完成本组投票", MUTED);
    footer(root, text);
}
