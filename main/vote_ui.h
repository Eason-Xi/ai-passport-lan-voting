#pragma once
#include "vote_model.h"
typedef struct {
    vote_model_t model;
    int battery;
    bool setup;
    bool setup_page_qr;
    bool setup_can_exit;
    bool settings_prompt;
    bool ballot_save_failed;
    char device[13];
    char ap_name[24];
    char ap_password[9];
    char status[128];
} vote_view_t;
void vote_ui_render(const vote_view_t *view);
void vote_ui_show_remaining(int64_t seconds);
