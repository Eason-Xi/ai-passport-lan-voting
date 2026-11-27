idf_component_register(
    SRCS "main.c" "vote_model.c" "vote_protocol.c" "vote_settings.c"
         "vote_net.c" "vote_discovery.c" "vote_portal.c" "vote_wifi_list.c" "vote_ui.c" "../assets/fonts/vote_zh18.c"
    INCLUDE_DIRS "."
    REQUIRES bsp esp_event esp_hw_support esp_netif esp_timer esp_wifi nvs_flash
             esp_http_server esp_websocket_client json mbedtls
    EMBED_TXTFILES "vote_setup.html"
)
