class UsersController < ApplicationController
  def index
    # ruleid: radr.ruby.sqli
    @users = User.where("name = '#{params[:name]}'")
    # ruleid: radr.ruby.sqli
    @sorted = User.order(params[:sort])
    q = params[:q]
    # ruleid: radr.ruby.sqli
    @rows = User.find_by_sql("SELECT * FROM users WHERE bio LIKE '%#{q}%'")
    # ok: radr.ruby.sqli
    @safe = User.where("name = ?", params[:name])
    # ok: radr.ruby.sqli
    @hash = User.where(name: params[:name])
    # ok: radr.ruby.sqli
    @fixed = User.order("created_at DESC")
  end
end
