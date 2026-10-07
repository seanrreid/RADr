class PagesController < ApplicationController
  def show
    # ruleid: radr.ruby.xss
    @bio = params[:bio].html_safe
    # ruleid: radr.ruby.xss
    render html: "<p>#{params[:msg]}</p>".html_safe
    # ok: radr.ruby.xss
    @clean = sanitize(params[:bio]).html_safe
    # ok: radr.ruby.xss
    @static = "<b>hi</b>".html_safe
  end
end
