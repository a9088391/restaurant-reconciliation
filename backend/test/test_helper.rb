# frozen_string_literal: true

ENV["RAILS_ENV"] ||= "test"
abort "測試必須使用 Compose test-db。" unless ENV["RAILS_ENV"] == "test" && ENV.key?("RECONCILIATION_DB_PASSWORD")

require_relative "../config/environment"
require "rails/test_help"

connection = ActiveRecord::Base.connection_pool.db_config
unless connection.host == "test-db" && connection.database == "restaurant_reconciliation_test"
  abort "測試拒絕在指定的隔離 PostgreSQL 以外執行。"
end

ActiveRecord::Base.connection_pool.with_connection do |db|
  abort "測試連線的實際資料庫不符。" unless db.select_value("SELECT current_database()") == "restaurant_reconciliation_test"
end
