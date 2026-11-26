// 直接链接固件 UI，用真实 LVGL 检查每个字形、页面和内存池。
#include "lvgl.h"
#include "vote_ui.h"
#include "vote_font_ranges.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
LV_FONT_DECLARE(vote_zh18);
static uint16_t frame[240 * 320];
static uint16_t buffer[240 * 20];
static uint32_t ticks;
static const char *output;
static vote_view_t view;
static int64_t seconds_left = -1;
static uint32_t tick(void) { return ticks; }
static void flush(lv_display_t *display, const lv_area_t *area, uint8_t *pixels)
{
    const uint16_t *src = (const uint16_t *)pixels;
    for (int y = area->y1; y <= area->y2; y++) {
        memcpy(frame + y * 240 + area->x1, src, (area->x2 - area->x1 + 1) * 2);
        src += area->x2 - area->x1 + 1;
    }
    lv_display_flush_ready(display);
}
static void labels(lv_obj_t *object)
{
    if (lv_obj_check_type(object, &lv_label_class)) {
        assert(lv_obj_get_style_text_font(object, LV_PART_MAIN) == &vote_zh18);
        lv_area_t coords;
        lv_obj_get_coords(object, &coords);
        assert(coords.y1 >= 0 && coords.y2 < 320 && coords.x1 >= 0 && coords.x2 < 240);
    }
    for (uint32_t i = 0; i < lv_obj_get_child_count(object); i++) labels(lv_obj_get_child(object, i));
}
static void capture(const char *name)
{
    vote_ui_render(&view);
    vote_ui_show_remaining(seconds_left);
    for (int i = 0; i < 8; i++) { ticks += 30; lv_timer_handler(); }
    labels(lv_screen_active());
    char path[512]; snprintf(path, sizeof(path), "%s/%s.ppm", output, name);
    FILE *file = fopen(path, "wb"); assert(file);
    fprintf(file, "P6\n240 320\n255\n");
    for (int y = 0; y < 320; y++) for (int x = 0; x < 240; x++) {
        uint16_t color = frame[y * 240 + x];
        int dx = x < 30 ? 30 - x : x > 209 ? x - 209 : 0;
        int dy = y < 30 ? 30 - y : y > 289 ? y - 289 : 0;
        if (dx && dy && dx * dx + dy * dy > 900) color = 0;
        fputc(((color >> 11) & 31) * 255 / 31, file);
        fputc(((color >> 5) & 63) * 255 / 63, file);
        fputc((color & 31) * 255 / 31, file);
    }
    fclose(file);
    lv_mem_monitor_t monitor; lv_mem_monitor(&monitor);
    printf("页面 %s：已用 %u，峰值 %u / %u 字节\n", name,
           (unsigned)(monitor.total_size - monitor.free_size), (unsigned)monitor.max_used, (unsigned)monitor.total_size);
    assert(monitor.max_used < monitor.total_size * 9 / 10);
}
int main(int argc, char **argv)
{
    assert(argc == 2); output = argv[1];
    lv_init(); lv_tick_set_cb(tick);
    lv_display_t *display = lv_display_create(240, 320); assert(display);
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(display, buffer, NULL, sizeof(buffer), LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(display, flush);
    unsigned count = 0;
    for (size_t i = 0; i < sizeof(VOTE_FONT_RANGES)/sizeof(VOTE_FONT_RANGES[0]); i++) {
        for (uint32_t cp = VOTE_FONT_RANGES[i][0]; cp <= VOTE_FONT_RANGES[i][1]; cp++) {
            lv_font_glyph_dsc_t glyph = {0};
            assert(lv_font_get_glyph_dsc(&vote_zh18, &glyph, cp, 0) && !glyph.is_placeholder);
            count++;
        }
    }
    lv_font_glyph_dsc_t missing = {0};
    assert(!lv_font_get_glyph_dsc(&vote_zh18, &missing, 0x1F600, 0) || missing.is_placeholder);
    printf("实际字体 cmap：%u 字符通过，已验证缺字负例\n", count);
    vote_model_init(&view.model); view.battery = 87;
    strcpy(view.device, "aabbcc123456"); strcpy(view.status, "连接路由器中");
    capture("01-connecting");
    view.setup = true; strcpy(view.ap_name, "Vote-123456"); strcpy(view.ap_password, "a8b3c5d7");
    strcpy(view.status, "等待填写配置"); capture("02-setup");
    view.setup_page_qr = true; capture("18-setup-link"); view.setup_page_qr = false;
    view.setup = false; view.model.connected = true; strcpy(view.status, "等待主持人发题");
    capture("03-waiting");
    vote_snapshot_t poll = {.id="0123456789abcdef", .title="周末团建，你更想去哪里？", .option_count=6, .phase=VOTE_OPEN, .my_choice=-1,
        .options={"森林公园", "历史博物馆", "海边露营", "城市骑行", "手工体验", "留在家里"}};
    vote_model_apply(&view.model, &poll); capture("04-vote");
    seconds_left = 65; capture("19-timed-vote");
    lv_obj_t *header = lv_obj_get_child(lv_screen_active(), 0);
    assert(strcmp(lv_label_get_text(header), "剩余 01:05") == 0);
    vote_ui_show_remaining(64);
    assert(strcmp(lv_label_get_text(header), "剩余 01:04") == 0);
    vote_ui_show_remaining(45296);
    assert(strcmp(lv_label_get_text(header), "剩余 12:34:56") == 0);
    seconds_left = 0; capture("20-awaiting-close");
    assert(strcmp(lv_label_get_text(lv_obj_get_child(lv_screen_active(), 0)), "等待截止确认") == 0);
    seconds_left = -1;
    view.model.selected = 5; capture("05-sixth-option");
    vote_model_key(&view.model, VOTE_OK); capture("06-confirm");
    vote_model_key(&view.model, VOTE_OK); capture("07-pending");
    view.model.connected = false; capture("08-offline-pending");
    poll.my_choice = 5; vote_model_apply(&view.model, &poll); capture("09-submitted");
    poll.phase = VOTE_CLOSED; poll.my_choice = -1; vote_model_apply(&view.model, &poll); capture("10-closed");
    poll.phase = VOTE_PUBLISHED; poll.total = 10;
    int counts[] = {3,2,1,2,1,1}; memcpy(poll.counts, counts, sizeof(counts));
    vote_model_apply(&view.model, &poll); capture("11-results");
    memset(poll.counts, 0, sizeof(poll.counts)); poll.total = 0; vote_model_apply(&view.model, &poll); capture("12-zero-results");
    view.settings_prompt = true; capture("13-settings");
    view.settings_prompt = false; view.battery = -1;
    strcpy(poll.title, "这是一个用于检查中文长题目和自动滚动显示的完整测试问题，请大家根据自己的真实想法进行选择");
    strcpy(poll.options[5], "这是用于检查选项自动滚动的二十四个中文汉字测试用例");
    vote_model_apply(&view.model, &poll); capture("14-long-text");
    for (int i = 0; i < 100; i++) {
        view.setup = i % 2; vote_ui_render(&view);
        ticks += 30; lv_timer_handler();
    }
    view.setup = false; capture("15-recreated");
    poll.total = 10; poll.counts[0] = 10; poll.my_choice = 0;
    vote_model_apply(&view.model, &poll); capture("16-unanimous");
    poll.phase = VOTE_OPEN; poll.my_choice = -1;
    vote_model_apply(&view.model, &poll);
    view.model.confirming = true; view.ballot_save_failed = true;
    capture("17-storage-retry");
    return 0;
}
