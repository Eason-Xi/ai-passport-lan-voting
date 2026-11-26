#pragma once
#include "esp_http_server.h"
#include <stdbool.h>
#include <stdint.h>

void vote_wifi_scan_done(void);
void vote_wifi_list_tick(const char *own_ssid, bool can_scan, int64_t now);
void vote_wifi_list_stop_scan(void);
esp_err_t vote_wifi_list_get(httpd_req_t *req);
