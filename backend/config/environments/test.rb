# frozen_string_literal: true

Rails.application.configure do
  config.enable_reloading = false
  config.eager_load = false
  config.consider_all_requests_local = false
  config.action_dispatch.show_exceptions = :all
  config.action_controller.allow_forgery_protection = true
  config.active_record.maintain_test_schema = false
end
