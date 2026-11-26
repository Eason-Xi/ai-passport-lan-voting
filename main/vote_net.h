#pragma once
#include "vote_ui.h"
#include "esp_err.h"
esp_err_t vote_net_init(vote_view_t *view);
void vote_net_tick(vote_view_t *view, int64_t now_ms);
int64_t vote_net_seconds_left(int64_t now_ms);
esp_err_t vote_net_setup(bool enabled);
esp_err_t vote_net_remember_choice(const vote_model_t *model);
