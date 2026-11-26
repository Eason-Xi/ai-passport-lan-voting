#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef struct {
    uint32_t version;
    char ssid[33];
    char password[64];
    char server[96];
    char code[7];
} vote_settings_t;
bool vote_settings_valid(const vote_settings_t *settings);
