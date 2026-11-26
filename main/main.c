// 共选：应用任务独占状态；按键回调只入队，所有界面更新持有 BSP 的 LVGL 锁。
#include "vote_net.h"
#include "vote_ui.h"
#include "bsp_display.h"
#include "bsp_button.h"
#include "bsp_battery.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>

typedef struct { bsp_btn_t key; bsp_btn_ev_t event; } input_t;
static QueueHandle_t s_keys;
static vote_view_t s_view;
static vote_view_t s_drawn;
static const char *TAG = "lan_vote";

static void on_button(bsp_btn_t key, bsp_btn_ev_t event, void *context)
{
    (void)context;
    if (event != BSP_BTN_CLICK && event != BSP_BTN_LONG && event != BSP_BTN_DOUBLE) return;
    const input_t input = {.key = key, .event = event};
    xQueueSend(s_keys, &input, 0);
}

void app_main(void)
{
    vote_model_init(&s_view.model);
    s_view.battery = -1;
    snprintf(s_view.status, sizeof(s_view.status), "正在启动");
    if (bsp_display_init() != ESP_OK || !bsp_lvgl_init()) {
        ESP_LOGE(TAG, "屏幕初始化失败，应用停止");
        return;
    }
    bsp_display_backlight(75);
    if (bsp_lvgl_lock(1000)) {
        vote_ui_render(&s_view);
        bsp_lvgl_unlock();
    }
    s_keys = xQueueCreate(8, sizeof(input_t));
    bool keys_ready = s_keys && bsp_button_init(on_button, NULL) == ESP_OK;
    bool battery_ready = bsp_battery_init() == ESP_OK;
    esp_err_t error = vote_net_init(&s_view);
    bool network_ready = error == ESP_OK;
    if (!network_ready) {
        ESP_LOGE(TAG, "网络初始化失败：%s；未擦除存储", esp_err_to_name(error));
        snprintf(s_view.status, sizeof(s_view.status), "网络启动失败，请重启");
    }
    int64_t last_active = esp_timer_get_time() / 1000;
    int64_t battery_at = 0, diagnostic_at = 0;
    int64_t drawn_seconds = -1;
    bool dimmed = false;
    for (;;) {
        int64_t now = esp_timer_get_time() / 1000;
        char previous_poll[sizeof(s_view.model.poll.id)];
        memcpy(previous_poll, s_view.model.poll.id, sizeof(previous_poll));
        vote_phase_t previous_phase = s_view.model.poll.phase;
        if (network_ready) vote_net_tick(&s_view, now);
        if (s_keys && (strcmp(previous_poll, s_view.model.poll.id) || previous_phase != s_view.model.poll.phase)) {
            // 题目切换或截止后，丢弃旧页面积压的按键，避免把旧确认用于新题。
            xQueueReset(s_keys);
        }
        input_t input;
        if (s_keys && xQueueReceive(s_keys, &input, 0) == pdTRUE) {
            last_active = now;
            if (dimmed) {
                bsp_display_backlight(75);
                dimmed = false; // 唤醒按键只点亮屏幕，防止误投。
            } else if (input.event == BSP_BTN_LONG && input.key == BSP_BTN_OK && network_ready) {
                if (s_view.setup) {
                    if (s_view.setup_can_exit && vote_net_setup(false) != ESP_OK)
                        snprintf(s_view.status, sizeof(s_view.status), "保存失败，请重试");
                } else s_view.settings_prompt = !s_view.settings_prompt;
            } else if (s_view.setup && input.event == BSP_BTN_CLICK && input.key != BSP_BTN_OK) {
                s_view.setup_page_qr = !s_view.setup_page_qr;
            } else if ((input.event == BSP_BTN_CLICK || input.event == BSP_BTN_DOUBLE) && !s_view.setup) {
                if (s_view.settings_prompt) {
                    if (input.key == BSP_BTN_OK && network_ready) {
                        if (vote_net_setup(true) != ESP_OK) snprintf(s_view.status, sizeof(s_view.status), "保存失败，请重试");
                    } else s_view.settings_prompt = false;
                } else {
                    const vote_key_t key = input.key == BSP_BTN_UP ? VOTE_UP :
                                           input.key == BSP_BTN_DOWN ? VOTE_DOWN : VOTE_OK;
                    s_view.ballot_save_failed = false;
                    if (vote_model_key(&s_view.model, key) && vote_net_remember_choice(&s_view.model) != ESP_OK) {
                        // 提交前先持久化。保存失败时仍停在确认页，不发送可能丢失的选票。
                        s_view.model.pending_choice = -1;
                        s_view.model.confirming = true;
                        s_view.ballot_save_failed = true;
                    }
                }
            }
        }
        if (now >= battery_at) {
            s_view.battery = battery_ready ? bsp_battery_soc() : -1;
            battery_at = now + 10000;
        }
        if (!keys_ready) snprintf(s_view.status, sizeof(s_view.status), "按键初始化失败");
        int64_t seconds = s_view.model.poll.phase == VOTE_OPEN && !s_view.setup && !s_view.settings_prompt
                          ? vote_net_seconds_left(now) : -1;
        bool redraw = memcmp(&s_view, &s_drawn, sizeof(s_view)) != 0;
        if (redraw || seconds != drawn_seconds) {
            bool wake = strcmp(s_view.model.poll.id, s_drawn.model.poll.id) || s_view.model.poll.phase != s_drawn.model.poll.phase;
            if (wake) {
                last_active = now;
                dimmed = false;
                bsp_display_backlight(75);
            }
            if (bsp_lvgl_lock(100)) {
                if (redraw) {
                    vote_ui_render(&s_view);
                    s_drawn = s_view;
                }
                // 每秒只更新倒计时标签，正在滚动的长题目和选项可以连续阅读。
                vote_ui_show_remaining(seconds);
                drawn_seconds = seconds;
                bsp_lvgl_unlock();
            }
        }
        if (!dimmed && now - last_active >= (s_view.setup ? 60000 : 30000)) {
            bsp_display_backlight(15);
            dimmed = true;
        }
        if (now >= diagnostic_at) {
            ESP_LOGI(TAG, "空闲堆=%u 最大连续块=%u 栈余量=%u", (unsigned)esp_get_free_heap_size(),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
                     (unsigned)uxTaskGetStackHighWaterMark(NULL));
            diagnostic_at = now + 60000;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
