class WebhooksController < ApplicationController
  # ruleid: radr.ruby.csrf-disabled
  skip_before_action :verify_authenticity_token
end

class PaymentsController < ApplicationController
  # ruleid: radr.ruby.csrf-disabled
  skip_forgery_protection only: [:create]
end

class SafeController < ApplicationController
  # ok: radr.ruby.csrf-disabled
  protect_from_forgery with: :exception
end
