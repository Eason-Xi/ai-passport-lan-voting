#include "vote_net.h"
#include "vote_protocol.h"
#include "vote_settings.h"
#include "vote_discovery.h"
#include "vote_portal.h"
#include "vote_wifi_list.h"
#include "cJSON.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define WIFI_READY BIT0
#define WS_READY BIT1
#define PHONE_READY BIT2
#define SETUP_TIMEOUT_MS 30000
static const char *TAG = "vote_net";
static EventGroupHandle_t s_events;
static QueueHandle_t s_config_queue;
static QueueHandle_t s_rx_queue;
static esp_websocket_client_handle_t s_ws;
static esp_netif_t *s_ap_netif;
static esp_netif_t *s_sta_netif;
static esp_netif_ip_info_t s_ap_ip;
static int s_dns_fd = -1;
static vote_discovery_t s_search = {.socket_fd = -1};
typedef struct { char ids[VOTE_HOST_LIMIT][17]; unsigned count; } host_choices_t;
static host_choices_t s_choices;
static portMUX_TYPE s_choice_lock = portMUX_INITIALIZER_UNLOCKED;
static vote_settings_t s_saved;
static vote_settings_t s_candidate;
static vote_pending_t s_persisted_vote;
static bool s_has_saved;
static bool s_setup;
static bool s_hello;
static uint32_t s_seen_generation;
static atomic_uint s_generation;
static atomic_int s_setup_status;
static int64_t s_test_start;
static int64_t s_retry_at;
static int64_t s_send_at;
static int64_t s_sync_at;
static int64_t s_deadline_ms = -1;
static int64_t s_rediscover_at;
static char s_error[128];
static vote_rx_t s_rx;
typedef struct { uint32_t generation; char text[VOTE_MESSAGE_BYTES]; } packet_t;
static packet_t s_callback_packet;
enum { SETUP_IDLE, SETUP_WIFI, SETUP_SAVED, SETUP_WIFI_FAILED, SETUP_STORE_FAILED,
       SETUP_FIND, SETUP_JOIN, SETUP_NO_HOST, SETUP_PICK, SETUP_BAD_CODE, SETUP_UNREACHABLE,
       SETUP_FULL, SETUP_DENIED, SETUP_QUEUED };
static const char *SETUP_TEXT[] = {
    "请选择现场网络", "正在连接现场网络", "已入场，即将重启", "无线连接失败，请检查密码", "保存失败，请重试",
    "正在寻找主持电脑", "正在核对入场码", "未找到主持台，请重试或手动填写地址",
    "发现多个主持台，请选择会场", "入场码错误，请重新填写", "主持电脑未响应，请检查网络",
    "本场设备已满，请联系主持人", "主持台暂未接受登记，请重试", "正在准备连接"
};
static bool setup_busy(int status)
{
    return status == SETUP_QUEUED || status == SETUP_WIFI || status == SETUP_FIND || status == SETUP_JOIN || status == SETUP_SAVED;
}
extern const char setup_html_start[] asm("_binary_vote_setup_html_start");
extern const char setup_html_end[] asm("_binary_vote_setup_html_end");

static void heap_log(const char *step)
{
    ESP_LOGI(TAG, "%s: 空闲堆=%u 最大连续块=%u", step,
             (unsigned)esp_get_free_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
}

static esp_err_t load_settings(void)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("lan_vote", NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    size_t length = sizeof(s_saved);
    err = nvs_get_blob(nvs, "network", &s_saved, &length);
    s_has_saved = err == ESP_OK && length == sizeof(s_saved) && s_saved.server[0] && vote_settings_valid(&s_saved);
    length = sizeof(s_persisted_vote);
    err = nvs_get_blob(nvs, "pending_v1", &s_persisted_vote, &length);
    if (err != ESP_OK || length != sizeof(s_persisted_vote)) {
        memset(&s_persisted_vote, 0, sizeof(s_persisted_vote));
    }
    uint8_t force = 0;
    nvs_get_u8(nvs, "setup", &force);
    s_setup = force || !s_has_saved;
    nvs_close(nvs);
    return ESP_OK;
}

esp_err_t vote_net_setup(bool enabled)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("lan_vote", NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    err = nvs_set_u8(nvs, "setup", enabled ? 1 : 0);
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    /* 通过重启切换配网/投票，避免旧网络任务访问已退出页面。 */
    if (err == ESP_OK) esp_restart();
    return err;
}

esp_err_t vote_net_remember_choice(const vote_model_t *model)
{
    vote_pending_t record = {.choice = model->pending_choice};
    memcpy(record.poll_id, model->poll.id, sizeof(record.poll_id));
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("lan_vote", NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(nvs, "pending_v1", &record, sizeof(record));
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    if (err == ESP_OK) s_persisted_vote = record;
    return err;
}

static esp_err_t save_candidate(void)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("lan_vote", NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(nvs, "network", &s_candidate, sizeof(s_candidate));
    if (err == ESP_OK) err = nvs_set_u8(nvs, "setup", 0);
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_events, WIFI_READY | WS_READY);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_events, WIFI_READY);
    } else if (base == IP_EVENT && id == IP_EVENT_AP_STAIPASSIGNED) {
        xEventGroupSetBits(s_events, PHONE_READY);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        vote_wifi_scan_done();
    }
}

static void websocket_event(void *arg, esp_event_base_t base, int32_t id, void *event_data)
{
    (void)arg; (void)base;
    if (id == WEBSOCKET_EVENT_CONNECTED) {
        memset(&s_rx, 0, sizeof(s_rx));
        atomic_fetch_add(&s_generation, 1);
        xEventGroupSetBits(s_events, WS_READY);
    } else if (id == WEBSOCKET_EVENT_DISCONNECTED || id == WEBSOCKET_EVENT_CLOSED) {
        memset(&s_rx, 0, sizeof(s_rx));
        xEventGroupClearBits(s_events, WS_READY);
    } else if (id == WEBSOCKET_EVENT_DATA) {
        const esp_websocket_event_data_t *data = event_data;
        if (data->payload_len < 0 || data->payload_offset < 0 || data->data_len < 0) return;
        int complete = vote_rx_push(&s_rx, data->op_code, data->fin, data->payload_len,
                                   data->payload_offset, data->data_ptr, data->data_len);
        if (complete == 1) {
            memset(&s_callback_packet, 0, sizeof(s_callback_packet));
            s_callback_packet.generation = atomic_load(&s_generation);
            memcpy(s_callback_packet.text, s_rx.text, s_rx.used + 1);
            /* 快照天然可替换，保留最新一份，限制慢屏幕造成的积压。 */
            xQueueOverwrite(s_rx_queue, &s_callback_packet);
        }
    }
}

static esp_err_t redirect_portal(httpd_req_t *req, httpd_err_code_t error)
{
    (void)error;
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_sendstr(req, "<a href=\"http://192.168.4.1/\">Open Wi-Fi setup</a>");
}

static bool portal_host(httpd_req_t *req)
{
    char host[40];
    return httpd_req_get_hdr_value_str(req, "Host", host, sizeof(host)) == ESP_OK &&
           (!strcmp(host, "192.168.4.1") || !strcmp(host, "192.168.4.1:80"));
}

static esp_err_t setup_networks(httpd_req_t *req)
{
    if (!portal_host(req)) return redirect_portal(req, HTTPD_404_NOT_FOUND);
    return vote_wifi_list_get(req);
}

static esp_err_t setup_page(httpd_req_t *req)
{
    if (!portal_host(req)) return redirect_portal(req, HTTPD_404_NOT_FOUND);
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, setup_html_start, setup_html_end - setup_html_start - 1);
}

static esp_err_t setup_status(httpd_req_t *req)
{
    if (!portal_host(req)) return redirect_portal(req, HTTPD_404_NOT_FOUND);
    int status = atomic_load(&s_setup_status);
    char json[512];
    int used = snprintf(json, sizeof(json), "{\"status\":%d,\"message\":\"%s\",\"busy\":%s,\"hosts\":[",
                        status, SETUP_TEXT[status], setup_busy(status) ? "true" : "false");
    if (status == SETUP_PICK) {
        host_choices_t choices;
        portENTER_CRITICAL(&s_choice_lock);
        choices = s_choices;
        portEXIT_CRITICAL(&s_choice_lock);
        for (unsigned i = 0; i < choices.count; i++)
            used += snprintf(json + used, sizeof(json) - used, "%s\"%s\"", i ? "," : "", choices.ids[i]);
    }
    strcpy(json + used, "]}");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_sendstr(req, json);
}

static bool copy_json_string(const cJSON *json, const char *key, char *dest, size_t size)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, key);
    if (!cJSON_IsString(item) || strlen(item->valuestring) >= size) return false;
    strcpy(dest, item->valuestring);
    return true;
}

static esp_err_t setup_submit(httpd_req_t *req)
{
    if (!portal_host(req)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "请从设备热点配网");
    if (setup_busy(atomic_load(&s_setup_status))) {
        httpd_resp_set_status(req, "409 Conflict");
        return httpd_resp_sendstr(req, "正在验证网络，请稍候");
    }
    if (req->content_len < 2 || req->content_len > 768) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "配置内容过长");
    }
    /* 配网页只在设备 AP 地址接收同源请求，拒绝其他站点提交。 */
    char origin[64];
    size_t origin_len = httpd_req_get_hdr_value_len(req, "Origin");
    if (origin_len && (origin_len >= sizeof(origin) ||
        httpd_req_get_hdr_value_str(req, "Origin", origin, sizeof(origin)) != ESP_OK ||
        strcmp(origin, "http://192.168.4.1") != 0)) {
        return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "请求来源无效");
    }
    char buffer[769];
    int used = 0;
    while (used < req->content_len) {
        int n = httpd_req_recv(req, buffer + used, req->content_len - used);
        if (n <= 0) return httpd_resp_send_err(req, HTTPD_408_REQ_TIMEOUT, "配置接收超时");
        used += n;
    }
    buffer[used] = 0;
    if (memchr(buffer, 0, used)) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "配置包含无效字符");
    }
    cJSON *json = vote_parse_json_object(buffer, sizeof(buffer) - 1);
    vote_settings_t config = {.version = 1};
    bool valid = false;
    const cJSON *pick = cJSON_GetObjectItemCaseSensitive(json, "host_id");
    if (cJSON_IsString(pick) && atomic_load(&s_setup_status) == SETUP_PICK) {
        portENTER_CRITICAL(&s_choice_lock);
        for (unsigned i = 0; i < s_choices.count; i++)
            if (!strcmp(pick->valuestring, s_choices.ids[i])) valid = true;
        portEXIT_CRITICAL(&s_choice_lock);
        if (valid) {
            config.version = 0; // 由应用任务沿用本次已验证的 Wi-Fi，仅选择主持台。
            snprintf(config.server, sizeof(config.server), "auto:%s", pick->valuestring);
        }
    } else {
        valid = json && copy_json_string(json, "ssid", config.ssid, sizeof(config.ssid)) &&
            copy_json_string(json, "password", config.password, sizeof(config.password)) &&
            (!cJSON_HasObjectItem(json, "server") || copy_json_string(json, "server", config.server, sizeof(config.server))) &&
            copy_json_string(json, "code", config.code, sizeof(config.code)) && vote_settings_valid(&config);
    }
    cJSON_Delete(json);
    if (!valid) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "请检查网络、密码、服务器 IPv4 地址及六位入场码");
    atomic_store(&s_setup_status, SETUP_QUEUED);
    if (xQueueSend(s_config_queue, &config, 0) != pdTRUE) {
        atomic_store(&s_setup_status, SETUP_WIFI_FAILED);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "配置繁忙，请重试");
    }
    httpd_resp_set_status(req, "202 Accepted");
    return httpd_resp_sendstr(req, "正在连接，请等待验证结果");
}

static esp_err_t accept_setup_client(httpd_handle_t server, int fd)
{
    (void)server;
    // APSTA 验证网络时只处理发到设备热点 IP 的连接，路由器一侧不能修改配置。
    struct sockaddr_storage address;
    socklen_t size = sizeof(address);
    esp_netif_ip_info_t ap;
    if (getsockname(fd, (struct sockaddr *)&address, &size) != 0 ||
        esp_netif_get_ip_info(s_ap_netif, &ap) != ESP_OK) return ESP_FAIL;
    if (address.ss_family == AF_INET) {
        const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)&address;
        return ipv4->sin_addr.s_addr == ap.ip.addr ? ESP_OK : ESP_FAIL;
    }
#if CONFIG_LWIP_IPV6
    if (address.ss_family == AF_INET6) {
        const struct in6_addr *ip = &((const struct sockaddr_in6 *)&address)->sin6_addr;
        if (IN6_IS_ADDR_V4MAPPED(ip) && !memcmp(&ip->s6_addr[12], &ap.ip.addr, 4)) return ESP_OK;
    }
#endif
    return ESP_FAIL;
}

static esp_err_t start_http(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 6144;
    config.max_open_sockets = 3;
    config.lru_purge_enable = true;
    config.recv_wait_timeout = 5;
    config.send_wait_timeout = 5;
    config.open_fn = accept_setup_client;
    httpd_handle_t server = NULL;
    esp_err_t err = httpd_start(&server, &config);
    if (err != ESP_OK) return err;
    const httpd_uri_t endpoints[] = {
        {.uri = "/", .method = HTTP_GET, .handler = setup_page},
        {.uri = "/status", .method = HTTP_GET, .handler = setup_status},
        {.uri = "/networks", .method = HTTP_GET, .handler = setup_networks},
        {.uri = "/config", .method = HTTP_POST, .handler = setup_submit},
    };
    for (size_t i = 0; i < sizeof(endpoints) / sizeof(endpoints[0]); i++) {
        err = httpd_register_uri_handler(server, &endpoints[i]);
        if (err != ESP_OK) { httpd_stop(server); return err; }
    }
    err = httpd_register_err_handler(server, HTTPD_404_NOT_FOUND, redirect_portal);
    if (err != ESP_OK) httpd_stop(server);
    return err;
}

static esp_err_t configure_sta(const vote_settings_t *settings)
{
    wifi_config_t config = {0};
    memcpy(config.sta.ssid, settings->ssid, strlen(settings->ssid));
    memcpy(config.sta.password, settings->password, strlen(settings->password));
    config.sta.threshold.authmode = settings->password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    config.sta.pmf_cfg.capable = true;
    return esp_wifi_set_config(WIFI_IF_STA, &config);
}

static bool bind_interface(int fd, esp_netif_t *netif)
{
    struct ifreq name = {0};
    return esp_netif_get_netif_impl_name(netif, name.ifr_name) == ESP_OK &&
           setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, &name, sizeof(name)) == 0;
}

esp_err_t vote_net_init(vote_view_t *view)
{
    esp_err_t err = nvs_flash_init();
    /* 不能通过擦除整个 NVS 掩盖存储错误。 */
    if (err != ESP_OK) return err;
    if ((err = load_settings()) != ESP_OK) return err;
    s_events = xEventGroupCreate();
    s_config_queue = xQueueCreate(1, sizeof(vote_settings_t));
    s_rx_queue = xQueueCreate(1, sizeof(packet_t));
    if (!s_events || !s_config_queue || !s_rx_queue) return ESP_ERR_NO_MEM;
    uint8_t mac[6];
    if ((err = esp_read_mac(mac, ESP_MAC_WIFI_STA)) != ESP_OK) return err;
    snprintf(view->device, sizeof(view->device), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    view->setup = s_setup;
    view->setup_can_exit = s_has_saved;
    if ((err = esp_netif_init()) != ESP_OK) return err;
    if ((err = esp_event_loop_create_default()) != ESP_OK) return err;
    s_sta_netif = esp_netif_create_default_wifi_sta();
    if (!s_sta_netif) return ESP_ERR_NO_MEM;
    if (s_setup) {
        s_ap_netif = esp_netif_create_default_wifi_ap();
        if (!s_ap_netif) return ESP_ERR_NO_MEM;
    }
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    heap_log("启动无线之前");
    if ((err = esp_wifi_init(&config)) != ESP_OK) return err;
    if ((err = esp_wifi_set_storage(WIFI_STORAGE_RAM)) != ESP_OK) return err;
    if ((err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL)) != ESP_OK) return err;
    if ((err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL)) != ESP_OK) return err;
    if (s_setup && (err = esp_event_handler_register(IP_EVENT, IP_EVENT_AP_STAIPASSIGNED, wifi_event, NULL)) != ESP_OK) return err;
    if ((err = esp_wifi_set_mode(s_setup ? WIFI_MODE_APSTA : WIFI_MODE_STA)) != ESP_OK) return err;
    if (s_setup) {
        snprintf(view->ap_name, sizeof(view->ap_name), "Vote-%s", view->device + 6);
        snprintf(view->ap_password, sizeof(view->ap_password), "%08lx", (unsigned long)esp_random());
        wifi_config_t ap = {0};
        memcpy(ap.ap.ssid, view->ap_name, strlen(view->ap_name));
        ap.ap.ssid_len = strlen(view->ap_name);
        memcpy(ap.ap.password, view->ap_password, 8);
        ap.ap.channel = 1;
        ap.ap.max_connection = 1;
        ap.ap.authmode = WIFI_AUTH_WPA2_PSK;
        if ((err = esp_wifi_set_config(WIFI_IF_AP, &ap)) != ESP_OK) return err;
    } else if ((err = configure_sta(&s_saved)) != ESP_OK) return err;
    if ((err = esp_wifi_start()) != ESP_OK) return err;
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    if (s_setup) {
        err = start_http();
        if (err == ESP_OK && esp_netif_get_ip_info(s_ap_netif, &s_ap_ip) == ESP_OK) {
            s_dns_fd = vote_portal_open(s_ap_ip.ip.addr);
            if (s_dns_fd >= 0 && !bind_interface(s_dns_fd, s_ap_netif)) {
                close(s_dns_fd);
                s_dns_fd = -1;
            }
            if (s_dns_fd >= 0) {
                esp_netif_dns_info_t dns = {0};
                dns.ip.type = ESP_IPADDR_TYPE_V4;
                dns.ip.u_addr.ip4 = s_ap_ip.ip;
                uint8_t offer_dns = 2;
                esp_netif_dhcps_stop(s_ap_netif);
                esp_netif_dhcps_option(s_ap_netif, ESP_NETIF_OP_SET, ESP_NETIF_DOMAIN_NAME_SERVER, &offer_dns, sizeof(offer_dns));
                esp_netif_set_dns_info(s_ap_netif, ESP_NETIF_DNS_MAIN, &dns);
                esp_err_t dhcp = esp_netif_dhcps_start(s_ap_netif);
                if (dhcp != ESP_OK && dhcp != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED) err = dhcp;
            }
        }
    } else err = esp_wifi_connect();
    if (err == ESP_OK) heap_log(s_setup ? "配网服务已启动" : "投票网络已启动");
    return err;
}

static void send_text(const char *text)
{
    int length = strlen(text);
    int sent = esp_websocket_client_send_text(s_ws, text, length, pdMS_TO_TICKS(150));
    if (sent != length) ESP_LOGW(TAG, "发送未完成，等待重连或幂等重试");
}

void vote_net_view_question(const char *poll_id)
{
    if (!s_ws || !s_hello || !poll_id[0]) return;
    char message[80];
    snprintf(message, sizeof(message), "{\"v\":1,\"type\":\"view\",\"poll_id\":\"%.16s\"}", poll_id);
    send_text(message);
}

static void stop_ws(void)
{
    if (s_ws) esp_websocket_client_destroy(s_ws);
    s_ws = NULL;
    s_hello = false;
    xEventGroupClearBits(s_events, WS_READY);
    xQueueReset(s_rx_queue);
}

static bool start_ws(const char *uri)
{
    struct ifreq name = {0};
    if (esp_netif_get_netif_impl_name(s_sta_netif, name.ifr_name) != ESP_OK) return false;
    const esp_websocket_client_config_t cfg = {
        .uri = uri, .if_name = &name, .task_stack = 4096, .buffer_size = 768,
        .reconnect_timeout_ms = 3000, .network_timeout_ms = 3000,
        .ping_interval_sec = 10, .pingpong_timeout_sec = 10, .enable_close_reconnect = true,
    };
    s_ws = esp_websocket_client_init(&cfg);
    if (!s_ws || esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, websocket_event, NULL) != ESP_OK ||
        esp_websocket_client_start(s_ws) != ESP_OK) {
        stop_ws();
        return false;
    }
    s_error[0] = 0;
    heap_log("WebSocket 已启动");
    return true;
}

static bool begin_search(int64_t now)
{
    esp_netif_ip_info_t ip;
    uint8_t nonce[8];
    esp_fill_random(nonce, sizeof(nonce));
    if (esp_netif_get_ip_info(s_sta_netif, &ip) != ESP_OK || !ip.ip.addr || !ip.netmask.addr ||
        !vote_discovery_begin(&s_search, ip.ip.addr, ip.netmask.addr, VOTE_DISCOVERY_PORT, nonce, now)) return false;
    if (bind_interface(s_search.socket_fd, s_sta_netif)) return true;
    vote_discovery_close(&s_search);
    return false;
}

static bool poll_session(vote_view_t *view, int64_t now_ms, EventBits_t bits, const char *code)
{
    bool accepted = false;
    uint32_t generation = atomic_load(&s_generation);
    if (!(bits & WS_READY) || generation != s_seen_generation) {
        view->model.connected = false;
        view->model.confirming = false;
        s_hello = false;
        s_seen_generation = generation;
    }
    if ((bits & WS_READY) && s_ws && !s_hello) {
        char hello[128];
        snprintf(hello, sizeof(hello), "{\"v\":1,\"type\":\"hello\",\"device_id\":\"%s\",\"code\":\"%s\"}", view->device, code);
        send_text(hello);
        s_hello = true;
        s_sync_at = now_ms + 5000;
        s_send_at = 0;
    }
    packet_t packet;
    if (xQueueReceive(s_rx_queue, &packet, 0) == pdTRUE && packet.generation == generation) {
        vote_snapshot_t snapshot;
        int64_t remaining_ms;
        cJSON *json = vote_parse_json_object(packet.text, sizeof(packet.text) - 1);
        if (vote_snapshot_from_json(json, &snapshot, &remaining_ms)) {
            if (bits & WS_READY) {
                accepted = true;
                if (!s_setup) {
                    s_deadline_ms = remaining_ms < 0 ? -1 : now_ms + remaining_ms;
                    vote_model_apply(&view->model, &snapshot);
                    vote_model_restore_pending(&view->model, &s_persisted_vote);
                }
                s_error[0] = 0;
            }
        } else {
            // 服务端发拒绝消息后可能立即关闭连接，断开也必须显示拒绝原因。
            const cJSON *type = cJSON_GetObjectItemCaseSensitive(json, "type");
            const cJSON *message = cJSON_GetObjectItemCaseSensitive(json, "message");
            if (cJSON_IsString(type) && !strcmp(type->valuestring, "error") && cJSON_IsString(message) &&
                strlen(message->valuestring) < sizeof(s_error) && vote_text_valid(message->valuestring, 40)) {
                strcpy(s_error, message->valuestring);
            } else snprintf(s_error, sizeof(s_error), "消息无效，等待同步");
        }
        cJSON_Delete(json);
    }
    return accepted;
}

int64_t vote_net_seconds_left(int64_t now_ms)
{
    if (s_deadline_ms < 0) return -1;
    if (now_ms >= s_deadline_ms) return 0;
    return (s_deadline_ms - now_ms + 999) / 1000;
}

static void setup_join(const char *uri, int64_t now)
{
    s_test_start = now;
    atomic_store(&s_setup_status, start_ws(uri) ? SETUP_JOIN : SETUP_UNREACHABLE);
}

static void setup_find(int64_t now)
{
    const char *id = s_candidate.server[0] ? s_candidate.server + 5 : NULL;
    if (!vote_discovery_poll(&s_search, id, now)) return;
    if (!s_search.count) {
        atomic_store(&s_setup_status, SETUP_NO_HOST);
    } else if (s_search.count == 1) {
        snprintf(s_candidate.server, sizeof(s_candidate.server), "auto:%s", s_search.hosts[0].id);
        setup_join(s_search.hosts[0].uri, now);
    } else {
        host_choices_t choices = {.count = (unsigned)s_search.count};
        for (unsigned i = 0; i < choices.count; i++)
            strcpy(choices.ids[i], s_search.hosts[i].id);
        portENTER_CRITICAL(&s_choice_lock);
        s_choices = choices;
        portEXIT_CRITICAL(&s_choice_lock);
        atomic_store(&s_setup_status, SETUP_PICK);
    }
}

static void setup_tick(vote_view_t *view, int64_t now, EventBits_t bits)
{
    vote_portal_tick(s_dns_fd, s_ap_ip.ip.addr, s_ap_ip.netmask.addr);
    if (bits & PHONE_READY) {
        xEventGroupClearBits(s_events, PHONE_READY);
        view->setup_page_qr = true;
    }
    vote_settings_t next;
    if (xQueueReceive(s_config_queue, &next, 0) == pdTRUE) {
        if (next.version == 0) {
            strcpy(s_candidate.server, next.server);
            next = s_candidate;
        }
        bool same_wifi = (bits & WIFI_READY) && !strcmp(next.ssid, s_candidate.ssid) &&
                         !strcmp(next.password, s_candidate.password);
        stop_ws();
        vote_discovery_close(&s_search);
        vote_wifi_list_stop_scan();
        s_candidate = next;
        s_error[0] = 0;
        s_test_start = now;
        atomic_store(&s_setup_status, SETUP_WIFI);
        if (!same_wifi) {
            esp_wifi_disconnect();
            xEventGroupClearBits(s_events, WIFI_READY);
            bits &= ~WIFI_READY;
            if (configure_sta(&s_candidate) != ESP_OK) atomic_store(&s_setup_status, SETUP_WIFI_FAILED);
            else esp_wifi_connect();
            s_retry_at = now + 5000;
        }
    }

    int stage = atomic_load(&s_setup_status);
    vote_wifi_list_tick(view->ap_name, !setup_busy(stage), now);
    if (stage == SETUP_WIFI) {
        wifi_ap_record_t ap;
        if ((bits & WIFI_READY) && esp_wifi_sta_get_ap_info(&ap) == ESP_OK &&
            !strncmp((const char *)ap.ssid, s_candidate.ssid, 32)) {
            if (!strncmp(s_candidate.server, "ws://", 5)) setup_join(s_candidate.server, now);
            else atomic_store(&s_setup_status, begin_search(now) ? SETUP_FIND : SETUP_NO_HOST);
        } else if (now - s_test_start >= SETUP_TIMEOUT_MS) {
            esp_wifi_disconnect();
            atomic_store(&s_setup_status, SETUP_WIFI_FAILED);
        } else if (now >= s_retry_at) {
            esp_wifi_connect();
            s_retry_at = now + 5000;
        }
    } else if (stage == SETUP_FIND) {
        setup_find(now);
    } else if (stage == SETUP_JOIN) {
        int outcome = SETUP_JOIN;
        if (poll_session(view, now, bits, s_candidate.code)) {
            outcome = save_candidate() == ESP_OK ? SETUP_SAVED : SETUP_STORE_FAILED;
        } else if (s_error[0]) {
            if (strstr(s_error, "入场码")) outcome = SETUP_BAD_CODE;
            else if (strstr(s_error, "设备已满") || strstr(s_error, "10 台")) outcome = SETUP_FULL;
            else outcome = SETUP_DENIED;
        } else if (!(bits & WIFI_READY) || now - s_test_start >= 12000) {
            outcome = SETUP_UNREACHABLE;
        }
        if (outcome != SETUP_JOIN) {
            stop_ws();
            s_test_start = now;
            atomic_store(&s_setup_status, outcome);
        }
    } else if (stage == SETUP_SAVED && now - s_test_start >= 3000) {
        esp_restart();
    }
    snprintf(view->status, sizeof(view->status), "%s", SETUP_TEXT[atomic_load(&s_setup_status)]);
}

static void connect_host(int64_t now)
{
    const char *uri = s_saved.server;
    if (!strncmp(uri, "auto:", 5)) {
        if (s_search.socket_fd < 0 && !begin_search(now)) {
            s_retry_at = now + 3000;
            return;
        }
        if (!vote_discovery_poll(&s_search, s_saved.server + 5, now)) return;
        if (!s_search.count) {
            snprintf(s_error, sizeof(s_error), "正在寻找已配对的主持台");
            s_retry_at = now + 3000;
            return;
        }
        uri = s_search.hosts[0].uri;
    }
    if (!start_ws(uri)) snprintf(s_error, sizeof(s_error), "连接服务启动失败");
    s_retry_at = now + 3000;
    s_rediscover_at = now + 10000;
}

void vote_net_tick(vote_view_t *view, int64_t now_ms)
{
    EventBits_t bits = xEventGroupGetBits(s_events);
    if (s_setup) {
        setup_tick(view, now_ms, bits);
        return;
    }
    if (!(bits & WIFI_READY)) {
        vote_discovery_close(&s_search);
        if (now_ms >= s_retry_at) {
            esp_wifi_connect();
            s_retry_at = now_ms + 5000;
        }
    } else if (!s_ws && now_ms >= s_retry_at) {
        connect_host(now_ms);
    } else if (s_ws && !strncmp(s_saved.server, "auto:", 5)) {
        if (bits & WS_READY) s_rediscover_at = now_ms + 10000;
        else if (now_ms >= s_rediscover_at) {
            // 主持电脑的 DHCP 地址或服务端口可能变化，按已配对会场重新查找。
            stop_ws();
            s_retry_at = now_ms;
        }
    }
    poll_session(view, now_ms, bits, s_saved.code);
    if (view->model.connected && view->model.pending_choice >= 0 && now_ms >= s_send_at) {
        char vote[128];
        snprintf(vote, sizeof(vote), "{\"v\":1,\"type\":\"vote\",\"poll_id\":\"%s\",\"choice\":%d}",
                 view->model.poll.id, view->model.pending_choice);
        send_text(vote);
        s_send_at = now_ms + 2000;
    }
    if ((bits & WS_READY) && s_hello && now_ms >= s_sync_at) {
        send_text("{\"v\":1,\"type\":\"sync\"}");
        s_sync_at = now_ms + 15000;
    }
    const char *status = !(bits & WIFI_READY) ? "连接路由器中" : view->model.connected ? "等待主持人发题" : "连接主持电脑中";
    snprintf(view->status, sizeof(view->status), "%s", s_error[0] ? s_error : status);
}
