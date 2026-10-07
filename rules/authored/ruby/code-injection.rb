class DynController < ApplicationController
  def run
    # ruleid: radr.ruby.code-injection
    eval(params[:expr])
    # ruleid: radr.ruby.code-injection
    klass = params[:type].constantize
    # ruleid: radr.ruby.code-injection
    current_user.send(params[:action_name])
    # ok: radr.ruby.code-injection
    current_user.send(:name)
  end
end
