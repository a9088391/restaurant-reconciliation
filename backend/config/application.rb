# frozen_string_literal: true

require_relative "boot"

require "rails"
require "active_record/railtie"
require "action_controller/railtie"

Bundler.require(*Rails.groups)

module RestaurantReconciliation
  class Application < Rails::Application
    config.load_defaults 8.1
    # 免登入展示仍限制 Host，並保留來源檢查與會話 cookie 的跨站請求防護。
    config.hosts = ["localhost", "127.0.0.1"]
    config.action_controller.forgery_protection_origin_check = true
    config.session_store :cookie_store, key: "_reconciliation_session", same_site: :lax
    config.log_level = :warn
    config.logger = ActiveSupport::Logger.new($stdout)
  end
end
