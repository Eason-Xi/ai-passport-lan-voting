#include "vote_wifi_list.h"
#include "vote_model.h"
#include "cJSON.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include <stdatomic.h>
#include <string.h>

typedef struct { char ssid[33]; bool open; } access_point_t;
typedef struct { access_point_t list[12]; unsigned count; } network_list_t;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static network_list_t s_list;
static atomic_bool s_request = true;
static atomic_bool s_scanning;
static atomic_bool s_finished;
static int64_t s_last_start = -10000;

void vote_wifi_scan_done(void)
{
    atomic_store(&s_finished, true);
}

void vote_wifi_list_stop_scan(void)
{
    if (atomic_load(&s_scanning)) esp_wifi_scan_stop();
}

void vote_wifi_list_tick(const char *own_ssid, bool can_scan, int64_t now)
{
    if (atomic_exchange(&s_finished, false)) {
        network_list_t result = {0};
        wifi_ap_record_t ap;
        while (result.count < 12 && esp_wifi_scan_get_ap_record(&ap) == ESP_OK) {
            ap.ssid[sizeof(ap.ssid) - 1] = 0;
            const char *name = (const char *)ap.ssid;
            if (!vote_ssid_displayable(name) || !strcmp(name, own_ssid)) continue;
            if (ap.authmode != WIFI_AUTH_OPEN && ap.authmode != WIFI_AUTH_WPA2_PSK &&
                ap.authmode != WIFI_AUTH_WPA_WPA2_PSK && ap.authmode != WIFI_AUTH_WPA3_PSK &&
                ap.authmode != WIFI_AUTH_WPA2_WPA3_PSK) continue;
            unsigned i = 0;
            while (i < result.count && strcmp(result.list[i].ssid, name)) i++;
            if (i != result.count) continue;
            strcpy(result.list[i].ssid, name);
            result.list[i].open = ap.authmode == WIFI_AUTH_OPEN;
            result.count++;
        }
        esp_wifi_clear_ap_list();
        portENTER_CRITICAL(&s_lock);
        s_list = result;
        portEXIT_CRITICAL(&s_lock);
        atomic_store(&s_scanning, false);
    }
    if (can_scan && !atomic_load(&s_scanning) && now - s_last_start >= 4000 &&
        atomic_exchange(&s_request, false)) {
        s_last_start = now;
        atomic_store(&s_scanning, esp_wifi_scan_start(NULL, false) == ESP_OK);
    }
}

esp_err_t vote_wifi_list_get(httpd_req_t *req)
{
    char query[32];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK && !strcmp(query, "refresh=1"))
        atomic_store(&s_request, true);
    network_list_t snapshot;
    portENTER_CRITICAL(&s_lock);
    snapshot = s_list;
    portEXIT_CRITICAL(&s_lock);
    cJSON *root = cJSON_CreateObject();
    cJSON *list = cJSON_AddArrayToObject(root, "networks");
    cJSON_AddBoolToObject(root, "scanning", atomic_load(&s_scanning) || atomic_load(&s_request));
    for (unsigned i = 0; list && i < snapshot.count; i++) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "ssid", snapshot.list[i].ssid);
        cJSON_AddBoolToObject(item, "open", snapshot.list[i].open);
        cJSON_AddItemToArray(list, item);
    }
    char *body = root && list ? cJSON_PrintUnformatted(root) : NULL;
    cJSON_Delete(root);
    if (!body) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "请稍后刷新网络");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t err = httpd_resp_sendstr(req, body);
    cJSON_free(body);
    return err;
}
