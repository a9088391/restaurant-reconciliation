# frozen_string_literal: true

# 本案資料模型共用的 Active Record 抽象基底，不對應獨立資料表。
class ApplicationRecord < ActiveRecord::Base
  primary_abstract_class
end
